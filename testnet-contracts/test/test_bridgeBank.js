const BridgeBank = artifacts.require("BridgeBank");
const CosmosToken = artifacts.require("CosmosToken");
// const Valset = artifacts.require("Valset");

const Web3Utils = require("web3-utils");
const EVMRevert = "revert";
const BigNumber = web3.BigNumber;

require("chai")
  .use(require("chai-as-promised"))
  .use(require("chai-bignumber")(BigNumber))
  .should();

contract("BridgeBank", function(accounts) {
  const operator = accounts[0];

  const userOne = accounts[1];

  describe("BridgeBank deployment and basics", function() {
    beforeEach(async function() {
      this.bridgeBank = await BridgeBank.new(operator);
    });

    it("should deploy the BridgeBank and set the operator", async function() {
      this.bridgeBank.should.exist;

      const bridgeBankOperator = await this.bridgeBank.operator();
      bridgeBankOperator.should.be.equal(operator);
    });

    it("should correctly set initial values of CosmosBank and EthereumBank", async function() {
      // EthereumBank initial values
      const nonce = Number(await this.bridgeBank.nonce());
      nonce.should.be.bignumber.equal(0);

      // CosmosBank initial values
      const cosmosTokenCount = Number(await this.bridgeBank.cosmosTokenCount());
      cosmosTokenCount.should.be.bignumber.equal(0);
    });

    it("should not allow a user to send ethereum directly to the contract", async function() {
      await this.bridgeBank
        .send(Web3Utils.toWei("0.25", "ether"), { from: userOne })
        .should.be.rejectedWith(EVMRevert);
    });
  });

  describe("BridgeToken creation (Cosmos assets)", function() {
    beforeEach(async function() {
      this.bridgeBank = await BridgeBank.new(operator);
      this.symbol = "ABC";
    });

    it("should not allow non-operators to create new BankTokens", async function() {
      await this.bridgeBank
        .createNewBridgeToken(this.symbol, {
          from: userOne
        })
        .should.be.rejectedWith(EVMRevert);
    });

    it("should allow the operator to create new BankTokens", async function() {
      await this.bridgeBank.createNewBridgeToken(this.symbol, {
        from: operator
      }).should.be.fulfilled;
    });

    it("should emit event LogNewBankToken containing the new BankToken's address and symbol", async function() {
      //Get the BankToken's address if it were to be created
      const expectedBankTokenAddress = await this.bridgeBank.createNewBridgeToken.call(
        this.symbol,
        {
          from: operator
        }
      );

      // Actually create the BankToken
      const { logs } = await this.bridgeBank.createNewBridgeToken(this.symbol, {
        from: operator
      });

      // Get the event logs and compare to expected BankToken address and symbol
      const event = logs.find(e => e.event === "LogNewBankToken");
      event.args._token.should.be.equal(expectedBankTokenAddress);
      event.args._symbol.should.be.equal(this.symbol);
    });

    it("should increase the BankToken count upon creation", async function() {
      const priorTokenCount = await this.bridgeBank.cosmosTokenCount();
      Number(priorTokenCount).should.be.bignumber.equal(0);

      await this.bridgeBank.createNewBridgeToken(this.symbol, {
        from: operator
      });

      const afterTokenCount = await this.bridgeBank.cosmosTokenCount();
      Number(afterTokenCount).should.be.bignumber.equal(1);
    });

    it("should add new BankTokens to the whitelist", async function() {
      // Get the BankToken's address if it were to be created
      const bankTokenAddress = await this.bridgeBank.createNewBridgeToken.call(
        this.symbol,
        {
          from: operator
        }
      );

      // Create the BridgeToken
      await this.bridgeBank.createNewBridgeToken(this.symbol, {
        from: operator
      });

      // Check BankToken whitelist
      const isOnWhitelist = await this.bridgeBank.bankTokenWhitelist(
        bankTokenAddress
      );
      isOnWhitelist.should.be.equal(true);
    });

    it("should allow the creation of BankTokens with the same symbol", async function() {
      // Get the first BankToken's address if it were to be created
      const firstBankTokenAddress = await this.bridgeBank.createNewBridgeToken.call(
        this.symbol,
        {
          from: operator
        }
      );

      // Create the first BankToken
      await this.bridgeBank.createNewBridgeToken(this.symbol, {
        from: operator
      });

      // Get the second BankToken's address if it were to be created
      const secondBankTokenAddress = await this.bridgeBank.createNewBridgeToken.call(
        this.symbol,
        {
          from: operator
        }
      );

      // Create the second BankToken
      await this.bridgeBank.createNewBridgeToken(this.symbol, {
        from: operator
      });

      // Check BankToken whitelist for both tokens
      const firstTokenOnWhitelist = await this.bridgeBank.bankTokenWhitelist.call(
        firstBankTokenAddress
      );
      const secondTokenOnWhitelist = await this.bridgeBank.bankTokenWhitelist.call(
        secondBankTokenAddress
      );

      // Should be different addresses
      firstBankTokenAddress.should.not.be.equal(secondBankTokenAddress);

      // Confirm whitelist status
      firstTokenOnWhitelist.should.be.equal(true);
      secondTokenOnWhitelist.should.be.equal(true);
    });
  });

  describe("BankToken minting (Cosmos assets)", function() {
    beforeEach(async function() {
      this.bridgeBank = await BridgeBank.new(operator);

      // Set up our variables
      this.amount = 100;
      this.sender = web3.utils.bytesToHex([
        "985cfkop78sru7gfud4wce83kuc9rmw89rqtzmy"
      ]);
      this.recipient = userOne;
      this.symbol = "ETH";
      this.bankToken = await this.bridgeBank.createNewBridgeToken.call(
        this.symbol,
        {
          from: operator
        }
      );

      // Create the BankToken, adding it to the whitelist
      await this.bridgeBank.createNewBridgeToken(this.symbol, {
        from: operator
      }).should.be.fulfilled;
    });

    // TODO: should be VALIDATORS
    it("should allow the operator to mint new BankTokens", async function() {
      await this.bridgeBank.mintBankTokens(
        this.sender,
        this.recipient,
        this.bankToken,
        this.symbol,
        this.amount,
        {
          from: operator
        }
      ).should.be.fulfilled;
    });

    it("should emit event LogBankTokenMint with correct values upon successful minting", async function() {
      const { logs } = await this.bridgeBank.mintBankTokens(
        this.sender,
        this.recipient,
        this.bankToken,
        this.symbol,
        this.amount,
        {
          from: operator
        }
      );

      const event = logs.find(e => e.event === "LogBankTokenMint");
      event.args._token.should.be.equal(this.bankToken);
      event.args._symbol.should.be.equal(this.symbol);
      Number(event.args._amount).should.be.bignumber.equal(this.amount);
      event.args._beneficiary.should.be.equal(this.recipient);
    });
  });

  describe("BankToken deposit locking (Ethereum/ERC20 assets)", function() {
    beforeEach(async function() {
      this.bridgeBank = await BridgeBank.new(operator);

      this.recipient = web3.utils.utf8ToHex(
        "985cfkop78sru7gfud4wce83kuc9rmw89rqtzmy"
      );
      // This is for Ethereum deposits
      this.ethereumToken = "0x0000000000000000000000000000000000000000";
      this.weiAmount = web3.utils.toWei("0.25", "ether");
      // This is for ERC20 deposits
      this.symbol = "TEST";
      this.token = await CosmosToken.new(this.symbol);
      this.amount = 100;

      //Load user account with ERC20 tokens for testing
      await this.token.mint(userOne, 1000, {
        from: operator
      }).should.be.fulfilled;

      // Approve tokens to contract
      await this.token.approve(this.bridgeBank.address, this.amount, {
        from: userOne
      }).should.be.fulfilled;
    });

    it("should allow users to lock ERC20 tokens", async function() {
      // Attempt to lock tokens
      await this.bridgeBank.lock(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      ).should.be.fulfilled;

      //Get the user and BridgeBank token balance after the transfer
      const bridgeBankTokenBalance = Number(
        await this.token.balanceOf(this.bridgeBank.address)
      );
      const userBalance = Number(await this.token.balanceOf(userOne));

      //Confirm that the tokens have been locked
      bridgeBankTokenBalance.should.be.bignumber.equal(100);
      userBalance.should.be.bignumber.equal(900);
    });

    it("should allow users to lock Ethereum", async function() {
      await this.bridgeBank.lock(
        this.recipient,
        this.ethereumToken,
        this.weiAmount,
        { from: userOne, value: this.weiAmount }
      ).should.be.fulfilled;

      const contractBalanceWei = await web3.eth.getBalance(
        this.bridgeBank.address
      );
      const contractBalance = Web3Utils.fromWei(contractBalanceWei, "ether");

      contractBalance.should.be.bignumber.equal(
        Web3Utils.fromWei(this.weiAmount, "ether")
      );
    });

    it("should generate unique deposit ID for a new deposit", async function() {
      //Simulate sha3 hash to get deposit's expected id
      const expectedID = Web3Utils.soliditySha3(
        { t: "address payable", v: userOne },
        { t: "bytes", v: this.recipient },
        { t: "address", v: this.token.address },
        { t: "int256", v: this.amount },
        { t: "int256", v: 1 }
      );

      //Get the deposit's id if it were to be created
      const depositID = await this.bridgeBank.lock.call(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );

      depositID.should.be.equal(expectedID);
    });

    it("should correctly mark new deposits as locked", async function() {
      //Get the deposit's expected id, then lock funds
      const depositID = await this.bridgeBank.lock.call(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );

      await this.bridgeBank.lock(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );

      //Check if a deposit has been created and locked
      const locked = await this.bridgeBank.getEthereumDepositStatus(depositID);
      locked.should.be.equal(true);
    });

    it("should be able to access the deposit's information by its ID", async function() {
      //Get the deposit's expected id, then lock funds
      const depositID = await this.bridgeBank.lock.call(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );

      await this.bridgeBank.lock(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );

      //Attempt to get an deposit's information
      await this.bridgeBank.viewEthereumDeposit(depositID).should.be.fulfilled;
    });

    it("should correctly store deposit information", async function() {
      //Get the deposit's expected id, then lock funds
      const depositID = await this.bridgeBank.lock.call(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );

      await this.bridgeBank.lock(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );

      //Get the deposit's information
      const depositData = await this.bridgeBank.viewEthereumDeposit(depositID);

      //Parse each attribute
      const sender = depositData[0];
      const receiver = depositData[1];
      const token = depositData[2];
      const amount = Number(depositData[3]);
      const nonce = Number(depositData[4]);

      //Confirm that each attribute is correct
      sender.should.be.equal(userOne);
      receiver.should.be.equal(this.recipient);
      token.should.be.equal(this.token.address);
      amount.should.be.bignumber.equal(this.amount);
      nonce.should.be.bignumber.equal(1);
    });
  });

  describe("BankToken deposit unlocking (Ethereum/ERC20 assets)", function() {
    beforeEach(async function() {
      this.bridgeBank = await BridgeBank.new(operator);
      this.recipient = web3.utils.bytesToHex([
        "985cfkop78sru7gfud4wce83kuc9rmw89rqtzmy"
      ]);
      // This is for Ethereum deposits
      this.ethereumToken = "0x0000000000000000000000000000000000000000";
      this.weiAmount = web3.utils.toWei("0.25", "ether");
      // This is for ERC20 deposits
      this.symbol = "TEST";
      this.token = await CosmosToken.new(this.symbol);
      this.amount = 100;

      //Load contract with ethereum so it can complete items
      await this.bridgeBank.send(web3.utils.toWei("1", "ether"), {
        from: operator
      }).should.be.fulfilled;

      //Get the Ethereum deposit's expected id, then lock funds
      this.depositID = await this.bridgeBank.lock.call(
        this.recipient,
        this.ethereumToken,
        this.weiAmount,
        {
          from: userOne,
          value: this.weiAmount
        }
      );

      await this.bridgeBank.lock(
        this.recipient,
        this.ethereumToken,
        this.weiAmount,
        {
          from: userOne,
          value: this.weiAmount
        }
      );

      //Load user account with ERC20 tokens for testing
      await this.token.mint(userOne, 1000, {
        from: operator
      }).should.be.fulfilled;

      // Approve tokens to contract
      await this.token.approve(this.bridgeBank.address, this.amount, {
        from: userOne
      }).should.be.fulfilled;

      //Get the deposit's expected id, then lock funds
      this.erc20DepositID = await this.bridgeBank.lock.call(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );

      await this.bridgeBank.lock(
        this.recipient,
        this.token.address,
        this.amount,
        {
          from: userOne,
          value: 0
        }
      );
    });

    it("should allow for an Ethereum deposit to be unlocked", async function() {
      await this.bridgeBank.unlock(this.depositID).should.be.fulfilled;
    });

    it("should allow for an ERC20 deposit to be unlocked", async function() {
      await this.bridgeBank.unlock(this.erc20DepositID).should.be.fulfilled;
    });

    it("should not allow for the unlocking of non-existant deposits", async function() {
      //Generate a fake Ethereum deposit id
      const fakeId = Web3Utils.soliditySha3(
        { t: "address payable", v: userOne },
        { t: "bytes", v: this.recipient },
        { t: "address", v: this.ethereumToken },
        { t: "int256", v: 12 },
        { t: "int256", v: 1 }
      );

      await this.bridgeBank.unlock(fakeId).should.be.rejectedWith(EVMRevert);
    });

    it("should not allow an unlocked deposit to be unlocked again", async function() {
      //Unlock the deposit
      await this.bridgeBank.unlock(this.depositID).should.be.fulfilled;

      //Attempt to Unlock the deposit again
      await this.bridgeBank
        .unlock(this.depositID)
        .should.be.rejectedWith(EVMRevert);
    });

    it("should update lock status of deposits upon completion", async function() {
      //Confirm that the deposit is locked
      const firstLockStatus = await this.bridgeBank.getEthereumDepositStatus(
        this.depositID
      );
      firstLockStatus.should.be.equal(true);

      //Unlock the deposit
      await this.bridgeBank.unlock(this.depositID).should.be.fulfilled;

      //Check that the deposit is unlocked
      const secondLockStatus = await this.bridgeBank.getEthereumDepositStatus(
        this.depositID
      );
      secondLockStatus.should.be.equal(false);
    });

    it("should emit an event upon unlock with the correct deposit information", async function() {
      //Get the event logs of an unlock
      const { logs } = await this.bridgeBank.unlock(this.erc20DepositID);
      const event = logs.find(e => e.event === "LogUnlock");

      event.args._to.should.be.equal(userOne);
      event.args._token.should.be.equal(this.token.address);
      Number(event.args._value).should.be.bignumber.equal(this.amount);
      Number(event.args._nonce).should.be.bignumber.equal(2);
    });

    // TODO: Original sender VS. intended recipient
    it("should correctly transfer unlocked Ethereum", async function() {
      //Get prior balances of user and BridgeBank contract
      const beforeUserBalance = Number(await web3.eth.getBalance(userOne));
      const beforeContractBalance = Number(
        await web3.eth.getBalance(this.bridgeBank.address)
      );

      await this.bridgeBank.unlock(this.depositID).should.be.fulfilled;

      //Get balances after completion
      const afterUserBalance = Number(await web3.eth.getBalance(userOne));
      const afterContractBalance = Number(
        await web3.eth.getBalance(this.bridgeBank.address)
      );

      //Expected balances
      afterUserBalance.should.be.bignumber.equal(
        beforeUserBalance + Number(this.weiAmount)
      );
      afterContractBalance.should.be.bignumber.equal(
        beforeContractBalance - Number(this.weiAmount)
      );
    });

    it("should correctly transfer unlocked ERC20 tokens", async function() {
      //Confirm that the tokens are locked on the contract
      const beforeBridgeBankBalance = Number(
        await this.token.balanceOf(this.bridgeBank.address)
      );
      const beforeUserBalance = Number(await this.token.balanceOf(userOne));

      beforeBridgeBankBalance.should.be.bignumber.equal(this.amount);
      beforeUserBalance.should.be.bignumber.equal(900);

      await this.bridgeBank.unlock(this.erc20DepositID);

      //Confirm that the tokens have been unlocked and transfered
      const afterBridgeBankBalance = Number(
        await this.token.balanceOf(this.bridgeBank.address)
      );
      const afterUserBalance = Number(await this.token.balanceOf(userOne));

      afterBridgeBankBalance.should.be.bignumber.equal(0);
      afterUserBalance.should.be.bignumber.equal(1000);
    });
  });
});
