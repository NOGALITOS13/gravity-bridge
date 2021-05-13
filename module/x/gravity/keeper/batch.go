package keeper

import (
	"fmt"
	"strconv"

	"github.com/cosmos/cosmos-sdk/store/prefix"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	"github.com/cosmos/gravity-bridge/module/x/gravity/types"
)

const BatchTxSize = 100

// BuildBatchTx starts the following process chain:
// - find bridged denominator for given voucher type
// - determine if a an unexecuted batch is already waiting for this token type, if so confirm the new batch would
//   have a higher total fees. If not exit withtout creating a batch
// - select available transactions from the sendToEthereum transaction pool sorted by fee desc
// - persist an batch tx object with an incrementing ID = nonce
// - emit an event
func (k Keeper) BuildBatchTx(
	ctx sdk.Context,
	contractAddress string,
	maxElements int) (*types.BatchTx, error) {
	if maxElements == 0 {
		return nil, sdkerrors.Wrap(types.ErrInvalid, "max elements value")
	}

	lastBatch := k.GetLastBatchTxByTokenType(ctx, contractAddress)

	// lastBatch may be nil if there are no existing batches, we only need
	// to perform this check if a previous batch exists
	if lastBatch != nil {
		// this traverses the current tx pool for this token type and determines what
		// fees a hypothetical batch would have if created
		currentFees := k.GetBatchFeesByTokenType(ctx, contractAddress)
		if currentFees == nil {
			return nil, sdkerrors.Wrap(types.ErrInvalid, "error getting fees from tx pool")
		}

		lastFees := lastBatch.GetFees()
		if lastFees.GT(currentFees.TotalFees) {
			return nil, sdkerrors.Wrap(types.ErrInvalid, "new batch would not be more profitable")
		}
	}

	selectedTx, err := k.pickUnbatchedTX(ctx, contractAddress, maxElements)
	if len(selectedTx) == 0 || err != nil {
		return nil, err
	}
	nextID := k.autoIncrementID(ctx, types.KeyLastBatchTxID)
	batch := &types.BatchTx{
		BatchNonce:    nextID,
		BatchTimeout:  k.getBatchTimeoutHeight(ctx),
		Transactions:  selectedTx,
		TokenContract: contractAddress,
	}
	k.StoreBatch(ctx, batch)

	// Get the checkpoint and store it as a legit past batch
	checkpoint := batch.GetCheckpoint(k.GetGravityID(ctx))
	k.SetPastEthSignatureCheckpoint(ctx, checkpoint)

	batchEvent := sdk.NewEvent(
		types.EventTypeBatchTx,
		sdk.NewAttribute(sdk.AttributeKeyModule, types.ModuleName),
		sdk.NewAttribute(types.AttributeKeyContract, k.GetBridgeContractAddress(ctx)),
		sdk.NewAttribute(types.AttributeKeyBridgeChainID, strconv.Itoa(int(k.GetBridgeChainID(ctx)))),
		sdk.NewAttribute(types.AttributeKeyBatchTxID, fmt.Sprint(nextID)),
		sdk.NewAttribute(types.AttributeKeyNonce, fmt.Sprint(nextID)),
	)
	ctx.EventManager().EmitEvent(batchEvent)
	return batch, nil
}

// This gets the batch timeout height in Ethereum blocks.
func (k Keeper) getBatchTimeoutHeight(ctx sdk.Context) uint64 {
	params := k.GetParams(ctx)
	currentCosmosHeight := ctx.BlockHeight()
	// we store the last accepted Cosmos and Ethereum heights, we do not concern ourselves if these values are zero because
	// no batch can be produced if the last Ethereum block height is not first populated by a deposit event.
	heights := k.GetLatestEthereumBlockHeight(ctx)
	if heights.CosmosBlockHeight == 0 || heights.EthereumBlockHeight == 0 {
		return 0
	}
	// we project how long it has been in milliseconds since the last Ethereum block height was accepted
	projectedMillis := (uint64(currentCosmosHeight) - heights.CosmosBlockHeight) * params.AverageBlockTime
	// we convert that projection into the current Ethereum height using the average Ethereum block time in millis
	projectedCurrentEthereumHeight := (projectedMillis / params.AverageEthereumBlockTime) + heights.EthereumBlockHeight
	// we convert our target time for block timeouts (lets say 12 hours) into a number of blocks to
	// place on top of our projection of the current Ethereum block height.
	blocksToAdd := params.TargetBatchTimeout / params.AverageEthereumBlockTime
	return projectedCurrentEthereumHeight + blocksToAdd
}

// BatchTxExecuted is run when the Cosmos chain detects that a batch has been executed on Ethereum
// It frees all the transactions in the batch, then cancels all earlier batches
func (k Keeper) BatchTxExecuted(ctx sdk.Context, tokenContract string, nonce uint64) error {
	b := k.GetBatchTx(ctx, tokenContract, nonce)
	if b == nil {
		return sdkerrors.Wrap(types.ErrUnknown, "nonce")
	}

	// cleanup sendToEthereum pool
	for _, tx := range b.Transactions {
		k.removePoolEntry(ctx, tx.Id)
	}
	var err error
	// Iterate through remaining batches
	k.IterateBatchTxs(ctx, func(key []byte, iter_batch *types.BatchTx) bool {
		// If the iterated batches nonce is lower than the one that was just executed, cancel it
		if iter_batch.BatchNonce < b.BatchNonce {
			err = k.CancelBatchTx(ctx, tokenContract, iter_batch.BatchNonce)
		}
		return false
	})

	// Delete batch since it is finished
	k.DeleteBatch(ctx, *b)

	return err
}

// StoreBatch stores a transaction batch
func (k Keeper) StoreBatch(ctx sdk.Context, batch *types.BatchTx) {
	store := ctx.KVStore(k.storeKey)
	// set the current block height when storing the batch
	batch.Block = uint64(ctx.BlockHeight())
	key := types.GetBatchTxKey(batch.TokenContract, batch.BatchNonce)
	store.Set(key, k.cdc.MustMarshalBinaryBare(batch))

	blockKey := types.GetBatchTxBlockKey(batch.Block)
	store.Set(blockKey, k.cdc.MustMarshalBinaryBare(batch))
}

// StoreBatchUnsafe stores a transaction batch w/o setting the height
func (k Keeper) StoreBatchUnsafe(ctx sdk.Context, batch *types.BatchTx) {
	store := ctx.KVStore(k.storeKey)
	key := types.GetBatchTxKey(batch.TokenContract, batch.BatchNonce)
	store.Set(key, k.cdc.MustMarshalBinaryBare(batch))

	blockKey := types.GetBatchTxBlockKey(batch.Block)
	store.Set(blockKey, k.cdc.MustMarshalBinaryBare(batch))
}

// DeleteBatch deletes an batch tx
func (k Keeper) DeleteBatch(ctx sdk.Context, batch types.BatchTx) {
	store := ctx.KVStore(k.storeKey)
	store.Delete(types.GetBatchTxKey(batch.TokenContract, batch.BatchNonce))
	store.Delete(types.GetBatchTxBlockKey(batch.Block))
}

// pickUnbatchedTX find TX in pool and remove from "available" second index
func (k Keeper) pickUnbatchedTX(
	ctx sdk.Context,
	contractAddress string,
	maxElements int) ([]*types.SendToEthereum, error) {
	var selectedTx []*types.SendToEthereum
	var err error
	k.IterateSendToEthereumPoolByFee(ctx, contractAddress, func(txID uint64, tx *types.SendToEthereum) bool {
		if tx != nil && tx.Fee != nil {
			selectedTx = append(selectedTx, tx)
			err = k.removeFromUnbatchedTXIndex(ctx, *tx.Fee, txID)
			return err != nil || len(selectedTx) == maxElements
		}

		return true
	})
	return selectedTx, err
}

// GetBatchTx loads a batch object. Returns nil when not exists.
func (k Keeper) GetBatchTx(ctx sdk.Context, tokenContract string, nonce uint64) *types.BatchTx {
	store := ctx.KVStore(k.storeKey)
	key := types.GetBatchTxKey(tokenContract, nonce)
	bz := store.Get(key)
	if len(bz) == 0 {
		return nil
	}
	var b types.BatchTx
	k.cdc.MustUnmarshalBinaryBare(bz, &b)
	for _, tx := range b.Transactions {
		tx.Transfer.Contract = tokenContract
		tx.Fee.Contract = tokenContract
	}
	return &b
}

// CancelBatchTx releases all TX in the batch and deletes the batch
func (k Keeper) CancelBatchTx(ctx sdk.Context, tokenContract string, nonce uint64) error {
	batch := k.GetBatchTx(ctx, tokenContract, nonce)
	if batch == nil {
		return types.ErrUnknown
	}
	for _, tx := range batch.Transactions {
		tx.Fee.Contract = tokenContract
		k.prependToUnbatchedTXIndex(ctx, tokenContract, *tx.Fee, tx.Id)
	}

	// Delete batch since it is finished
	k.DeleteBatch(ctx, *batch)

	batchEvent := sdk.NewEvent(
		types.EventTypeBatchTxCanceled,
		sdk.NewAttribute(sdk.AttributeKeyModule, types.ModuleName),
		sdk.NewAttribute(types.AttributeKeyContract, k.GetBridgeContractAddress(ctx)),
		sdk.NewAttribute(types.AttributeKeyBridgeChainID, strconv.Itoa(int(k.GetBridgeChainID(ctx)))),
		sdk.NewAttribute(types.AttributeKeyBatchTxID, fmt.Sprint(nonce)),
		sdk.NewAttribute(types.AttributeKeyNonce, fmt.Sprint(nonce)),
	)
	ctx.EventManager().EmitEvent(batchEvent)
	return nil
}

// IterateBatchTxs iterates through all batch txs in DESC order.
func (k Keeper) IterateBatchTxs(ctx sdk.Context, cb func(key []byte, batch *types.BatchTx) bool) {
	prefixStore := prefix.NewStore(ctx.KVStore(k.storeKey), types.BatchTxKey)
	iter := prefixStore.ReverseIterator(nil, nil)
	defer iter.Close()
	for ; iter.Valid(); iter.Next() {
		var batch types.BatchTx
		k.cdc.MustUnmarshalBinaryBare(iter.Value(), &batch)
		// cb returns true to stop early
		if cb(iter.Key(), &batch) {
			break
		}
	}
}

// GetBatchTxs returns the batch txs
func (k Keeper) GetBatchTxs(ctx sdk.Context) (out []*types.BatchTx) {
	k.IterateBatchTxs(ctx, func(_ []byte, batch *types.BatchTx) bool {
		out = append(out, batch)
		return false
	})
	return
}

// GetLastBatchTxByTokenType gets the latest batch tx by token type
func (k Keeper) GetLastBatchTxByTokenType(ctx sdk.Context, token string) *types.BatchTx {
	batches := k.GetBatchTxs(ctx)
	var lastBatch *types.BatchTx = nil
	lastNonce := uint64(0)
	for _, batch := range batches {
		if batch.TokenContract == token && batch.BatchNonce > lastNonce {
			lastBatch = batch
			lastNonce = batch.BatchNonce
		}
	}
	return lastBatch
}

// SetLastSlashedBatchBlock sets the latest slashed Batch block height
func (k Keeper) SetLastSlashedBatchBlock(ctx sdk.Context, blockHeight uint64) {
	store := ctx.KVStore(k.storeKey)
	store.Set(types.LastSlashedBatchBlock, types.UInt64Bytes(blockHeight))
}

// GetLastSlashedBatchBlock returns the latest slashed Batch block
func (k Keeper) GetLastSlashedBatchBlock(ctx sdk.Context) uint64 {
	store := ctx.KVStore(k.storeKey)
	bytes := store.Get(types.LastSlashedBatchBlock)

	if len(bytes) == 0 {
		return 0
	}
	return types.UInt64FromBytes(bytes)
}

// GetUnSlashedBatches returns all the unslashed batches in state
func (k Keeper) GetUnSlashedBatches(ctx sdk.Context, maxHeight uint64) (out []*types.BatchTx) {
	lastSlashedBatchBlock := k.GetLastSlashedBatchBlock(ctx)
	k.IterateBatchBySlashedBatchBlock(ctx,
		lastSlashedBatchBlock,
		maxHeight,
		func(_ []byte, batch *types.BatchTx) bool {
			if batch.Block > lastSlashedBatchBlock {
				out = append(out, batch)
			}
			return false
		})
	return
}

// IterateBatchBySlashedBatchBlock iterates through all Batch by last slashed Batch block in ASC order
func (k Keeper) IterateBatchBySlashedBatchBlock(
	ctx sdk.Context,
	lastSlashedBatchBlock uint64,
	maxHeight uint64,
	cb func([]byte, *types.BatchTx) bool) {
	prefixStore := prefix.NewStore(ctx.KVStore(k.storeKey), types.BatchTxBlockKey)
	iter := prefixStore.Iterator(types.UInt64Bytes(lastSlashedBatchBlock), types.UInt64Bytes(maxHeight))
	defer iter.Close()

	for ; iter.Valid(); iter.Next() {
		var Batch types.BatchTx
		k.cdc.MustUnmarshalBinaryBare(iter.Value(), &Batch)
		// cb returns true to stop early
		if cb(iter.Key(), &Batch) {
			break
		}
	}
}
