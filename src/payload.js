'use strict';

module.exports = Payload;

////////////////////////////////////////////////////////////////////////////////
// dependencies
var assert       = require('assert');
var WalletCrypto = require('./wallet-crypto');
var Wallet       = require('./blockchain-wallet');

////////////////////////////////////////////////////////////////////////////////
// Payload
function Payload (object, loginPassword) {
  var obj = object || {};

  this._payload = obj.payload;

  try {
    var pay = JSON.parse(obj.payload);
    this._pbkdf2_iterations = pay.pbkdf2_iterations || 5000;
    this._version           = pay.version || 3;
    this._encryptedData     = pay.payload;

  } catch (e) {
    this._version = 1;
  }

  this._wallet            = null;
  this._real_auth_type    = obj.real_auth_type || 0;
  this._guid              = obj.guid;
  this._payload_checksum  = obj.payload_checksum;
  this._war_checksum      = obj.war_checksum;
  this._sync_pubkeys      = obj.sync_pubkeys || false;
  this._language          = obj.language || 'en';
  this._password          = loginPassword;
}

Payload.prototype.decrypt = function () {
  this._wallet = new Wallet(WalletCrypto.decryptWalletSync(this._payload, this._password));
  return this;
};

// properties, getters, setters
// every time we make a change, 1) encrypt wallet 2) create a new payload 3) compute checksum 4) push

//  i have to store somewhere in a (encryption) closure the user password when i log in.
//  segurament pot ser walletcrypto que sinstancia guardant stat del password inclus de la sharedkey
//  i need a settings class to store all the wallet settings (now is shared js) maybe inside wallet object

// Payload.prototype.toJSON = function (){
//   return {
//     pbkdf2_iterations : this._pbkdf2_iterations,
//     version           : this._version,
//     payload           : this._payload // encrypted wallet (string)
//   };
// };
//
// Payload.prototype.toWallet = function (){
//   // decrypt payload
//   // construct the wallet (give to it pbkdf iterations)
//   // return the wallet object
//   return 0;
// };
//
// // constructor
// Payload.fromWallet = function (walletObject){
//   var o = {};
//   o.pbkdf2_iterations = walletObject._pbkdf2_iterations; // todo, use getter
//   // encrypt the wallet to generate payload
//   o.version = 3; // if upgraded to hd 3 else 2
//   return new Payload(o);
//
// };
