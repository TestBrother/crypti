var crypto = require('crypto'),
	bignum = require('bignum'),
	ed = require('ed25519'),
	params = require('../helpers/params.js'),
	slots = require('../helpers/slots.js'),
	Router = require('../helpers/router.js');

//private
var modules, library, self;

var accounts = {};

function Account(address, publicKey, balance, unconfirmedBalance) {
	this.address = address;
	this.publicKey = publicKey;
	this.balance = balance || 0;
	this.unconfirmedBalance = unconfirmedBalance || 0;
	this.unconfirmedSignature = false;
	this.secondSignature = false;
	this.secondPublicKey = null;
	this.delegates = null;
}

Account.prototype.setUnconfirmedSignature = function (unconfirmedSignature) {
	this.unconfirmedSignature = unconfirmedSignature;
}

Account.prototype.setSecondSignature = function (secondSignature) {
	this.secondSignature = secondSignature;
}

Account.prototype.addToBalance = function (amount) {
	this.balance += amount;
	library.bus.message('changeBalance', this, amount);
}

Account.prototype.addToUnconfirmedBalance = function (amount) {
	this.unconfirmedBalance += amount;
}

Account.prototype.updateDelegateList = function (delegateIds) {
	library.bus.message('changeDelegates', this, delegateIds);
	this.delegates = delegateIds;
}

//constructor
function Accounts(cb, scope) {
	library = scope;
	self = this;

	attachApi();

	setImmediate(cb, null, self);
}

//private methods
function attachApi() {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) return next();
		res.status(500).send({success: false, error: 'loading'});
	});

	router.post('/open', function (req, res) {
		var secret = params.string(req.body.secret);

		if (!secret) {
			return res.json({success: false, error: "Provide secret key of account"});
		}

		var account = openAccount(secret);

		return res.json({
			success: true,
			account: {
				address: account.address,
				unconfirmedBalance: account.unconfirmedBalance,
				balance: account.balance,
				publicKey: account.publicKey,
				unconfirmedSignature: account.unconfirmedSignature,
				secondSignature: account.secondSignature,
				secondPublicKey: account.secondPublicKey || null
			}
		});
	});

	router.get('/getBalance', function (req, res) {
		var address = params.string(req.query.address);

		if (!address) {
			return res.json({success: false, error: "Provide address in url"});
		}

		var account = self.getAccount(address);
		var balance = account ? account.balance : 0;
		var unconfirmedBalance = account ? account.unconfirmedBalance : 0;

		return res.json({success: true, balance: balance, unconfirmedBalance: unconfirmedBalance});
	});

	router.get('/getPublicKey', function (req, res) {
		var address = params.string(req.query.address);

		if (!address) {
			return res.json({success: false, error: "Provide address in url"});
		}

		var account = self.getAccount(address);

		if (!account || !account.publicKey) {
			return res.json({success: false, error: "Account public key can't be found "});
		}

		return res.json({success: true, publicKey: account.publicKey});
	});

	router.post("/generatePublicKey", function (req, res) {
		var secret = params.string(req.body.secret);

		if (!secret) {
			return res.json({success: false, error: "Provide secret key to generate public key"});
		}

		var account = openAccount(secret);
		return res.json({success: true, publicKey: account.publicKey});
	});

	router.get("/delegates", function (req, res) {
		var address = params.string(req.query.address);

		if (!address) {
			return res.json({success: false, error: "Provide address in url"});
		}

		var account = self.getAccount(address);

		return res.json({success: true, delegates: account.delegates});
	});

	router.put("/delegates", function (req, res) {
		var secret = params.string(req.body.secret),
			publicKey = params.string(req.body.publicKey),
			secondSecret = params.string(req.body.secondSecret),
			delegates = params.array(req.body.delegates);

		var hash = crypto.createHash('sha256').update(secret, 'utf8').digest();
		var keypair = ed.MakeKeypair(hash);

		if (publicKey) {
			if (keypair.publicKey.toString('hex') != publicKey) {
				return res.json({success: false, error: "Please, provide valid secret key of your account"});
			}
		}

		if (delegates.length > 33){
			return res.json({success: false, error: "Please, provide less 33th delegates"});
		}

		var account = modules.accounts.getAccountByPublicKey(keypair.publicKey.toString('hex'));

		if (!account) {
			return res.json({success: false, error: "Account doesn't has balance"});
		}

		if (!account.publicKey) {
			return res.json({success: false, error: "Open account to make transaction"});
		}

		var transaction = {
			type: 3,
			amount: 0,
			recipientId: account.address,
			senderPublicKey: account.publicKey,
			timestamp: slots.getTime(),
			asset: {
				votes: delegates.length ? delegates : null
			}
		};

		modules.transactions.sign(secret, transaction);

		if (account.secondSignature) {
			if (!secondSecret || secondSecret.length == 0) {
				return res.json({success: false, error: "Provide second secret key"});
			}

			modules.transactions.secondSign(secondSecret, transaction);
		}

		modules.transactions.processUnconfirmedTransaction(transaction, true, function (err) {
			if (err) {
				return res.json({success: false, error: err});
			}

			res.json({success: true, transaction: transaction});
		});
	});

	router.get("/", function (req, res) {
		var address = params.string(req.query.address);

		if (!address) {
			return res.json({success: false, error: "Provide address in url"});
		}

		var account = self.getAccount(address);

		if (!account) {
			return res.json({success: false, error: "Account not found"});
		}

		return res.json({
			success: true,
			account: {
				address: account.address,
				unconfirmedBalance: account.unconfirmedBalance,
				balance: account.balance,
				publicKey: account.publicKey || null,
				unconfirmedSignature: account.unconfirmedSignature,
				secondSignature: account.secondSignature,
				secondPublicKey: account.secondPublicKey || null
			}
		});
	})

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: 'api not found'});
	});

	library.app.use('/api/accounts', router);
	library.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error('/api/accounts', err)
		res.status(500).send({success: false, error: err});
	});
}

function addAccount(account) {
	if (!accounts[account.address]) {
		accounts[account.address] = account;
	}
}

function openAccount(secret) {
	var hash = crypto.createHash('sha256').update(secret, 'utf8').digest();
	var keypair = ed.MakeKeypair(hash);

	return self.getAccountOrCreateByPublicKey(keypair.publicKey.toString('hex'));
}

//public methods
Accounts.prototype.getAccount = function (id) {
	return accounts[id];
}

Accounts.prototype.getAccountByPublicKey = function (publicKey) {
	var address = self.getAddressByPublicKey(publicKey);
	return self.getAccount(address);
}

Accounts.prototype.getAddressByPublicKey = function (publicKey) {
	var publicKeyHash = crypto.createHash('sha256').update(publicKey, 'hex').digest();
	var temp = new Buffer(8);
	for (var i = 0; i < 8; i++) {
		temp[i] = publicKeyHash[7 - i];
	}

	var address = bignum.fromBuffer(temp).toString() + "C";
	return address;
}

Accounts.prototype.getAccountOrCreateByPublicKey = function (publicKey) {
	var account, address;

	address = self.getAddressByPublicKey(publicKey);
	account = self.getAccount(address);

	if (account && !account.publicKey) {
		account.publicKey = publicKey;
	}

	if (!account) {
		account = new Account(address, publicKey);
		addAccount(account);
	}
	return account;
}

Accounts.prototype.getAccountOrCreateByAddress = function (address) {
	var account;

	account = self.getAccount(address);

	if (!account) {
		account = new Account(address);
		addAccount(account);
	}
	return account;
}

Accounts.prototype.getAllAccounts = function () {
	return accounts;
}

Accounts.prototype.getDelegates = function (publicKey) {
	var account = self.getAccountByPublicKey(publicKey);
	return account.delegates;

}

//events
Accounts.prototype.onBind = function (scope) {
	modules = scope;
}

//export
module.exports = Accounts;