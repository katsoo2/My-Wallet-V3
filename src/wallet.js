'use strict';

var MyWallet = module.exports = {};

var assert = require('assert');
var Buffer = require('buffer').Buffer;

var WalletStore = require('./wallet-store');
var WalletCrypto = require('./wallet-crypto');
var WalletSignup = require('./wallet-signup');
var WalletNetwork = require('./wallet-network');
var API = require('./api');
var Wallet = require('./blockchain-wallet');
var Helpers = require('./helpers');
var BlockchainSocket = require('./blockchain-socket');
var BlockchainSettingsAPI = require('./blockchain-settings-api');
var Payload = require('./payload');

var isInitialized = false;
MyWallet.wallet = undefined;
MyWallet.ws = new BlockchainSocket();

// used locally
function socketConnect () {
  MyWallet.ws.connect(onOpen, onMessage, onClose);

  var last_on_change = null;

  function onMessage (message) {
    var obj = null;

    if (!(typeof window === 'undefined')) {
      message = message.data;
    }
    try {
      obj = JSON.parse(message);
    }
    catch (e) {
      console.log('Websocket error: could not parse message data as JSON: ' + message);
      return;
    }

    if (obj.op == 'on_change') {
      var old_checksum = WalletStore.generatePayloadChecksum();
      var new_checksum = obj.checksum;

      if (last_on_change != new_checksum && old_checksum != new_checksum) {
        last_on_change = new_checksum;

        MyWallet.getWallet();
      }

    } else if (obj.op == 'utx') {
      WalletStore.sendEvent('on_tx_received');
      var sendOnTx = WalletStore.sendEvent.bind(null, 'on_tx');
      MyWallet.wallet.getHistory().then(sendOnTx);

    }  else if (obj.op == 'block') {
      var sendOnBlock = WalletStore.sendEvent.bind(null, 'on_block');
      MyWallet.wallet.getHistory().then(sendOnBlock);
      MyWallet.wallet.latestBlock = obj.x;
    }
  }

  function onOpen () {
    WalletStore.sendEvent('ws_on_open');
    var accounts = MyWallet.wallet.hdwallet? MyWallet.wallet.hdwallet.activeXpubs : [];
    var msg = MyWallet.ws.msgOnOpen(MyWallet.wallet.guid, MyWallet.wallet.activeAddresses, accounts);
    MyWallet.ws.send(msg);
  }

  function onClose () {
    WalletStore.sendEvent('ws_on_close');
  }
}

// used two times
function didDecryptWallet (success) {

  //We need to check if the wallet has changed
  MyWallet.getWallet();
  WalletStore.resetLogoutTimeout();
  success();
}

//Fetch a new wallet from the server
//success(modified true/false)
// used locally and iOS
MyWallet.getWallet = function (success, error) {
  var data = {method : 'wallet.aes.json', format : 'json'};

  if (WalletStore.getPayloadChecksum() && WalletStore.getPayloadChecksum().length > 0)
    data.checksum = WalletStore.getPayloadChecksum();

  API.securePostCallbacks('wallet', data, function (obj) {
    if (!obj.payload || obj.payload == 'Not modified') {
      if (success) success();
      return;
    }

    WalletStore.setEncryptedWalletData(obj.payload);

    decryptAndInitializeWallet(function () {
      MyWallet.wallet.getHistory();

      if (success) success();
    }, function () {
      if (error) error();
    });
  }, function (e) {
    if (error) error();
  });
};

////////////////////////////////////////////////////////////////////////////////

function decryptAndInitializeWallet (success, error, decrypt_success, build_hd_success) {
  assert(success, 'Success callback required');
  assert(error, 'Error callback required');
  var encryptedWalletData = WalletStore.getEncryptedWalletData();

  if (encryptedWalletData == null || encryptedWalletData.length == 0) {
    error('No Wallet Data To Decrypt');
    return;
  }
  WalletCrypto.decryptWallet(
    encryptedWalletData,
    WalletStore.getPassword(),
    function (obj, rootContainer) {
      decrypt_success && decrypt_success();
      MyWallet.wallet = new Wallet(obj);

      // this sanity check should be done on the load
      // if (!sharedKey || sharedKey.length == 0 || sharedKey.length != 36) {
      //   throw 'Shared Key is invalid';
      // }

      // TODO: pbkdf2 iterations should be stored correctly on wallet wrapper
      if (rootContainer) {
        WalletStore.setPbkdf2Iterations(rootContainer.pbkdf2_iterations);
      }
      //If we don't have a checksum then the wallet is probably brand new - so we can generate our own
      if (WalletStore.getPayloadChecksum() == null || WalletStore.getPayloadChecksum().length == 0) {
        WalletStore.setPayloadChecksum(WalletStore.generatePayloadChecksum());
      }
      if (MyWallet.wallet.isUpgradedToHD === false) {
        WalletStore.sendEvent('hd_wallets_does_not_exist');
      }
      setIsInitialized();
      success();
    },
    error
  );
}

////////////////////////////////////////////////////////////////////////////////

// used in the frontend
MyWallet.makePairingCode = function (success, error) {
  try {
    API.securePostCallbacks('wallet', { method : 'pairing-encryption-password' }, function (encryption_phrase) {
      var pwHex = new Buffer(WalletStore.getPassword()).toString('hex');
      var encrypted = WalletCrypto.encrypt(MyWallet.wallet.sharedKey + '|' + pwHex, encryption_phrase, 10);
      success('1|' + MyWallet.wallet.guid + '|' + encrypted);
    }, function (e) {
      error(e);
    });
  } catch (e) {
    error(e);
  }
};


MyWallet.jaume = function(guid) {
  var clientTime = (new Date()).getTime();
  var data = { format : 'json', resend_code : null, ct : clientTime, api_code : API.API_CODE };
  // if (shared_key) { data.sharedKey = shared_key; }
  return API.request('GET', 'wallet/' + guid, data, true, false);
}

MyWallet.fakeLogin = function(ignoredGUID) {
  ////////////////////////////////////////////////////////////////////////////////
  var example = {
    "auth_type": 0,
    "real_auth_type": 0,
    "symbol_local": {
      "symbol": "€",
      "code": "EUR",
      "symbolAppearsAfter": false,
      "name": "Euro",
      "local": true,
      "conversion": 251405.70084797
    },
    "clientTimeDiff": 191,
    "war_checksum": "e723544a70a7ae2d",
    "language": "es",
    "symbol_btc": {
      "symbol": "BTC",
      "code": "BTC",
      "symbolAppearsAfter": true,
      "name": "Bitcoin",
      "local": false,
      "conversion": 100000000
    },
    "extra_seed": "ee7f7174e38f5097cb3c5460aff511812b71a69724a52be7147a321425e745523a8c3ef17465b16867dc5fc57cbbca0a9f73c7066d4ce42df92dd05d4a2a3146",
    "payload": "{\"pbkdf2_iterations\":5000,\"version\":3,\"payload\":\"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\"}",
    "guid": "37f008fe-4456-43b8-8862-d2ac67053f52",
    "serverTime": 1456719058524,
    "payload_checksum": "63b54e117d559efd6a88419b6c7a573bb833c23a6283b5112d3caf3e2c7a9c54",
    "sync_pubkeys": false
  };
  ////////////////////////////////////////////////////////////////////////////////
  return Promise.resolve(example).then(function(a){return new Blockchain.Payload(a,'miABUELAesCALVA');});
}
// Blockchain.MyWallet.jaume("37f008fe-4456-43b8-8862-d2ac67053f52").then(Blockchain.MyWallet.idprint);


MyWallet.print = function(x) { console.log(x); return x;};

////////////////////////////////////////////////////////////////////////////////
MyWallet.login = function ( user_guid
                          , shared_key
                          , inputedPassword
                          , twoFA
                          , success
                          , needs_two_factor_code
                          , wrong_two_factor_code
                          , authorization_required
                          , other_error
                          , fetch_success
                          , decrypt_success
                          , build_hd_success) {

  assert(success, 'Success callback required');
  assert(other_error, 'Error callback required');
  assert(twoFA !== undefined, '2FA code must be null or set');
  assert(
    twoFA === null ||
    Helpers.isString(twoFA) ||
    (Helpers.isPositiveInteger(twoFA.type) && Helpers.isString(twoFA.code))
  );

  var clientTime = (new Date()).getTime();
  var data = { format : 'json', resend_code : null, ct : clientTime, api_code : API.API_CODE };

  if (shared_key) { data.sharedKey = shared_key; }

  var tryToFetchWalletJSON = function (guid, successCallback) {

    var success = function (obj) {
      fetch_success && fetch_success();
      // Even if Two Factor is enabled, some settings need to be saved here,
      // because they won't be part of the 2FA response.

      if (!obj.guid) {
        WalletStore.sendEvent('msg', {type: 'error', message: 'Server returned null guid.'});
        other_error('Server returned null guid.');
        return;
      }

      // I should create a new class to store the encrypted wallet over wallet
      WalletStore.setGuid(obj.guid);
      WalletStore.setRealAuthType(obj.real_auth_type);
      WalletStore.setSyncPubKeys(obj.sync_pubkeys);

      if (obj.payload && obj.payload.length > 0 && obj.payload != 'Not modified') {
      } else {
        needs_two_factor_code(obj.auth_type);
        return;
      }
      successCallback(obj)
    };

    var error = function (e) {
       console.log(e);
       var obj = 'object' === typeof e ? e : JSON.parse(e);
       if(obj && obj.initial_error && !obj.authorization_required) {
         other_error(obj.initial_error);
         return;
       }
       WalletStore.sendEvent('did_fail_set_guid');
       if (obj.authorization_required && typeof(authorization_required) === 'function') {
         authorization_required(function () {
           MyWallet.pollForSessionGUID(function () {
             tryToFetchWalletJSON(guid, successCallback);
           });
         });
       }
       if (obj.initial_error) {
         WalletStore.sendEvent('msg', {type: 'error', message: obj.initial_error});
       }
    };
    API.request('GET', 'wallet/' + guid, data, true, false).then(success).catch(error);
  };

  var tryToFetchWalletWith2FA = function (guid, two_factor_auth, successCallback) {

    if(Helpers.isString(two_factor_auth)) {
      two_factor_auth = {
        type: null,
        code: two_factor_auth
      };
    }

    if (two_factor_auth.code == null) {
      other_error('Two Factor Authentication code this null');
      return;
    }
    if (two_factor_auth.code.length == 0 || two_factor_auth.code.length > 255) {
     other_error('You must enter a Two Factor Authentication code');
     return;
    }

    var two_factor_auth_key = two_factor_auth.code;

    switch(two_factor_auth.type) {
      case 2: // email
      case 4: // sms
      case 5: // Google Auth
        two_factor_auth_key = two_factor_auth_key.toUpperCase();
      break;
    }

    var success = function (data) {
     if (data == null || data.length == 0) {
       other_error('Server Return Empty Wallet Data');
       return;
     }
     if (data != 'Not modified') { WalletStore.setEncryptedWalletData(data); }
     successCallback(data);
    };
    var error = function (response) {
     WalletStore.setRestoringWallet(false);
     wrong_two_factor_code(response);
    };

    var myData = { guid: guid, payload: two_factor_auth_key, length : two_factor_auth_key.length,  method : 'get-wallet', format : 'plain', api_code : API.API_CODE};
    API.request('POST', 'wallet', myData, true, false).then(success).catch(error);
  };

  var didFetchWalletJSON = function (obj) {
    if (obj.payload && obj.payload.length > 0 && obj.payload != 'Not modified') {
     WalletStore.setEncryptedWalletData(obj.payload);
    }

    if (obj.language && WalletStore.getLanguage() != obj.language) {
     WalletStore.setLanguage(obj.language);
    }
    MyWallet.initializeWallet(inputedPassword, success, other_error, decrypt_success, build_hd_success);
  }

  if(twoFA == null) {
    tryToFetchWalletJSON(user_guid, didFetchWalletJSON)
  } else {
    // If 2FA is enabled and we already fetched the wallet before, don't fetch
    // it again
    if(user_guid === WalletStore.getGuid() && WalletStore.getEncryptedWalletData()) {
      MyWallet.initializeWallet(inputedPassword, success, other_error, decrypt_success, build_hd_success);
    } else {
      tryToFetchWalletWith2FA(user_guid, twoFA, didFetchWalletJSON)
    }
  }
};
////////////////////////////////////////////////////////////////////////////////

// used locally
MyWallet.pollForSessionGUID = function (successCallback) {

  if (WalletStore.isPolling()) return;
  WalletStore.setIsPolling(true);
  var data = {format : 'json'};
  var success = function (obj) {
    if (obj.guid) {
      WalletStore.setIsPolling(false);
      WalletStore.sendEvent('msg', {type: 'success', message: 'Authorization Successful'});
      successCallback()
    } else {
      if (WalletStore.getCounter() < 600) {
        WalletStore.incrementCounter();
        setTimeout(function () {
          API.request('GET', 'wallet/poll-for-session-guid', data, true, false).then(success).catch(error);
        }, 2000);
      } else {
        WalletStore.setIsPolling(false);
      }
    }
  }
  var error = function () {
    WalletStore.setIsPolling(false);
  }
  API.request('GET', 'wallet/poll-for-session-guid', data, true, false).then(success).catch(error);
};
// used locally
////////////////////////////////////////////////////////////////////////////////

MyWallet.initializeWallet = function (pw, success, other_error, decrypt_success, build_hd_success) {
  assert(success, 'Success callback required');
  assert(other_error, 'Error callback required');
  if (isInitialized || WalletStore.isRestoringWallet()) {
    return;
  }

  function _error (e) {
    WalletStore.setRestoringWallet(false);
    WalletStore.sendEvent('msg', {type: 'error', message: e});

    WalletStore.sendEvent('error_restoring_wallet');
    other_error(e);
  }

  WalletStore.setRestoringWallet(true);
  WalletStore.unsafeSetPassword(pw);

  decryptAndInitializeWallet(
    function () {
      WalletStore.setRestoringWallet(false);
      didDecryptWallet(success);
    }
    , _error
    , decrypt_success
    , build_hd_success
  );
};

////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

// used on iOS
MyWallet.getIsInitialized = function () {
  return isInitialized;
};

// used once
function setIsInitialized () {
  if (isInitialized) return;
  socketConnect();
  isInitialized = true;
}

////////////////////////////////////////////////////////////////////////////////
// This should replace backup functions
function syncWallet (successcallback, errorcallback) {

  var panic = function (e) {
      console.log('Panic ' + e);
      window.location.replace('/');
      throw 'Save disabled.';
      // kick out of the wallet in a inconsistent state to prevent save
  };

  if (MyWallet.wallet.isEncryptionConsistent === false) {
    panic('The wallet was not fully enc/decrypted');
  }

  if (!MyWallet.wallet || !MyWallet.wallet.sharedKey
      || MyWallet.wallet.sharedKey.length === 0
      || MyWallet.wallet.sharedKey.length !== 36)
    { throw 'Cannot backup wallet now. Shared key is not set'; };

  WalletStore.disableLogout();

  var _errorcallback = function (e) {
    WalletStore.sendEvent('on_backup_wallet_error');
    WalletStore.sendEvent('msg', {type: 'error', message: 'Error Saving Wallet: ' + e});
    // Re-fetch the wallet from server
    MyWallet.getWallet();
    // try to save again:
    // syncWallet(successcallback, errorcallback);
    errorcallback && errorcallback(e);
  };
  try {
    var method = 'update';
    var data = JSON.stringify(MyWallet.wallet, null, 2);
    var crypted = WalletCrypto.encryptWallet( data
                                              , WalletStore.getPassword()
                                              , WalletStore.getPbkdf2Iterations()
                                              , MyWallet.wallet.isUpgradedToHD ?  3.0 : 2.0 );

    if (crypted.length == 0) {
      throw 'Error encrypting the JSON output';
    }

    //Now Decrypt the it again to double check for any possible corruption
    WalletCrypto.decryptWallet(crypted, WalletStore.getPassword(), function (obj) {
      try {
        var oldChecksum = WalletStore.getPayloadChecksum();
        WalletStore.sendEvent('on_backup_wallet_start');
        WalletStore.setEncryptedWalletData(crypted);
        var new_checksum = WalletStore.getPayloadChecksum();
        var data =  {
          length: crypted.length,
          payload: crypted,
          checksum: new_checksum,
          method : method,
          format : 'plain',
          language : WalletStore.getLanguage()
        };

        if (Helpers.isHex(oldChecksum)) {
          data.old_checksum = oldChecksum;
        }

        if (WalletStore.isSyncPubKeys()) {
          // Include HD addresses unless in lame mode:
          var hdAddresses = (
            MyWallet.wallet.hdwallet != undefined &&
            MyWallet.wallet.hdwallet.accounts != undefined
          ) ? [].concat.apply([],
            MyWallet.wallet.hdwallet.accounts.map(function (account) {
              return account.labeledReceivingAddresses
            })) : [];
          data.active = [].concat.apply([],
            [
              MyWallet.wallet.activeAddresses,
              hdAddresses
            ]
          ).join('|');
        }

        API.securePostCallbacks(
            'wallet'
          , data
          , function (data) {
              WalletNetwork.checkWalletChecksum(
                  new_checksum
                , function () {
                    WalletStore.setIsSynchronizedWithServer(true);
                    WalletStore.enableLogout();
                    WalletStore.resetLogoutTimeout();
                    WalletStore.sendEvent('on_backup_wallet_success');
                    successcallback && successcallback();
                    }
                , function () {
                    _errorcallback('Checksum Did Not Match Expected Value');
                    WalletStore.enableLogout();
                  }
              );
            }
          , function (e) {
            WalletStore.enableLogout();
            _errorcallback(e);
          }
        );

      } catch (e) {
        _errorcallback(e);
        WalletStore.enableLogout();
      }
    },
                               function (e) {
                                 console.log(e);
                                 throw('Decryption failed');
                               });
  } catch (e) {
    _errorcallback(e);
    WalletStore.enableLogout();
  }

}
MyWallet.syncWallet = Helpers.asyncOnce(syncWallet, 1500, function (){
  console.log('SAVE CALLED...');
  WalletStore.setIsSynchronizedWithServer(false);
});

/**
 * @param {string} inputedEmail user email
 * @param {string} inputedPassword user main password
 * @param {string} languageCode fiat currency code (e.g. USD)
 * @param {string} currencyCode language code (e.g. en)
 * @param {function (string, string, string)} success callback function with guid, sharedkey and password
 * @param {function (string)} error callback function with error message
 */
 // used on mywallet, iOS and frontend
MyWallet.createNewWallet = function (inputedEmail, inputedPassword, firstAccountName, languageCode, currencyCode, success, error, isHD) {
  WalletSignup.generateNewWallet(inputedPassword, inputedEmail, firstAccountName, function (createdGuid, createdSharedKey, createdPassword) {
    if (languageCode) {
      WalletStore.setLanguage(languageCode);
      BlockchainSettingsAPI.change_language(languageCode, (function () {}));
    }

    if (currencyCode) {
      BlockchainSettingsAPI.change_local_currency(currencyCode, (function () {}));
    }

    WalletStore.unsafeSetPassword(createdPassword);
    success(createdGuid, createdSharedKey, createdPassword);
  }, function (e) {
    error(e);
  }, isHD);
};

// used on frontend
MyWallet.recoverFromMnemonic = function (inputedEmail, inputedPassword, recoveryMnemonic, bip39Password, success, error, startedRestoreHDWallet, accountProgress, generateUUIDProgress, decryptWalletProgress) {
  var walletSuccess = function (guid, sharedKey, password) {
    WalletStore.unsafeSetPassword(password);
    var runSuccess = function () {success({ guid: guid, sharedKey: sharedKey, password: password});};
    MyWallet.wallet.restoreHDWallet(recoveryMnemonic, bip39Password, undefined, startedRestoreHDWallet, accountProgress).then(runSuccess).catch(error);
  };
  WalletSignup.generateNewWallet(inputedPassword, inputedEmail, null, walletSuccess, error, true, generateUUIDProgress, decryptWalletProgress);
};

// used frontend and mywallet
MyWallet.logout = function (force) {
  if (!force && WalletStore.isLogoutDisabled())
    return;
  var reload = function () {
    try { window.location.reload(); } catch (e) {
      console.log(e);
    }
  };
  var data = {format : 'plain', api_code : API.API_CODE};
  WalletStore.sendEvent('logging_out');
  API.request('GET', 'wallet/logout', data, true, false).then(reload).catch(reload);
};
