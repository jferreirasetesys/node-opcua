/**
 * @module opcua.server
 */
import _ from "underscore";
import assert from "better-assert";
import util from "util";
import { EventEmitter } from "events";
import crypto_utils from "lib/misc/crypto_utils";
import { split_der } from "lib/misc/crypto_explore_certificate";
import { MessageBuilder } from "lib/misc/message_builder";
import { MessageChunker } from "lib/misc/message_chunker";
import { SecurityPolicy, getOptionsForSymmetricSignAndEncrypt, fromURI } from "lib/misc/security_policy";


import secure_channel_service from "lib/services/secure_channel_service";
import { SecurityTokenRequestType } from "lib/services/get_endpoints_service";


import { StatusCode } from "lib/datamodel/opcua_status_code";
import { StatusCodes } from "lib/datamodel/opcua_status_code";
import { 
  MessageSecurityMode,
  ChannelSecurityToken,
  ServiceFault
} from "lib/datamodel/structures";
import crypto from "crypto";
import { analyze_object_binary_encoding } from "lib/misc/packet_analyzer";
import { get_clock_tick, make_debugLog, checkDebugFlag } from "lib/misc/utils";
import { constructObject } from "lib/misc/factories";
import { ServerTCP_transport } from "lib/transport/server_tcp_transport";


const debugLog = make_debugLog(__filename);
const doDebug = checkDebugFlag(__filename);


const AsymmetricAlgorithmSecurityHeader = secure_channel_service.AsymmetricAlgorithmSecurityHeader;

const OpenSecureChannelRequest = secure_channel_service.OpenSecureChannelRequest;
const OpenSecureChannelResponse = secure_channel_service.OpenSecureChannelResponse;


assert(MessageSecurityMode);
assert(ChannelSecurityToken);
assert(OpenSecureChannelRequest);
assert(OpenSecureChannelResponse);
assert(SecurityTokenRequestType);
assert(ServiceFault);

const do_trace_message = process.env.DEBUG && (process.env.DEBUG.indexOf("TRACE")) >= 0;


let last_channel_id = 0;
function getNextChannelId() {
  last_channel_id += 1;
  return last_channel_id;
}

/**
 * @class ServerSecureChannelLayer
 * @extends EventEmitter
 * @uses MessageBuilder
 * @uses MessageChunker
 * @constructor
 * @param options
 * @param options.parent {OPCUAServerEndPoint} parent
 * @param [options.timeout = 10000] {Number} timeout in milliseconds
 * @param [options.defaultSecureTokenLifetime = 30000] defaultSecureTokenLifetime
 * @param [options.objectFactory] an factory that provides a method constructObject(id) for the message builder
 */
class ServerSecureChannelLayer extends EventEmitter {
  constructor(options = {}) {
    super();
    const self = this;

    self.parent = options.parent;

    self.protocolVersion = 0;

    self.lastTokenId = 0;

    self.timeout = options.timeout || 10000; // connection timeout

    self.defaultSecureTokenLifetime = options.defaultSecureTokenLifetime || 600000;

    // uninitialized securityToken
    self.securityToken = { secureChannelId: 0, tokenId: 0 };

    self.serverNonce = null; // will be created when needed


    options.objectFactory = options.objectFactory || { constructObject };
    assert(_.isObject(options.objectFactory));

    self.messageBuilder = new MessageBuilder({ objectFactory: options.objectFactory });

    self.messageBuilder.privateKey = self.getPrivateKey();

    // disabled self.messageBuilder.on("chunk", function (chunk) {});

    // disabled self.messageBuilder.on("full_message_body", function (full_message_body) { });

    self.messageBuilder.on("error", (err) => {
      // istanbul ignore next
      if (doDebug) {
        debugLog("xxxxx error ".red, err.message.yellow, err.stack);
        debugLog("xxxxx Server is now closing socket, without further notice".red);
      }
      // close socket immediately
      self.close(undefined);
    });


    // at first use a anonymous connection
    self.securityHeader = new AsymmetricAlgorithmSecurityHeader({
      securityPolicyUri: "http://opcfoundation.org/UA/SecurityPolicy#None",
      senderCertificate: null,
      receiverCertificateThumbprint: null
    });

    self.messageChunker = new MessageChunker({
      securityHeader: self.securityHeader // for OPN
    });

    self.secureChannelId = getNextChannelId();

    self._tick0 = 0;

    self.securityMode = MessageSecurityMode.INVALID;

    self.timeoutId = 0;

    self._transactionsCount = 0;

    self.sessionTokens = {};
  }
  /**
   * the endpoint associated with this secure channel
   * @property endpoints
   * @type {OPCUAServerEndPoint}
   *
   */
  get endpoints() {
    return this.parent;
  }

  get securityTokenCount() {
    assert(_.isNumber(this.lastTokenId));
    return this.lastTokenId;
  }
  get remoteAddress() {
    return this._remoteAddress;
  }

  get remotePort() {
    return this._remotePort;
  }
  /**
   * the number of bytes read so far by this channel
   * @property bytesRead
   * @type {Number}
   */
  get bytesRead() {
    const self = this;
    return self.transport ? self.transport.bytesRead : 0;
  }

  /**
   * the number of bytes written so far by this channel
   * @property bytesWritten
   * @type {Number}
   */
  get bytesWritten() {
    const self = this;
    return self.transport ? self.transport.bytesWritten : 0;
  }

  get transactionsCount() {
    const self = this;
    return self._transactionsCount;
  }

  /**
   * true when the secure channel has been opened successfully
   * @property isOpened
   * @type {Boolean}
   *
   */
  get isOpened() {
    const self = this;
    return self.clientCertificate;
  }

  /**
   * true when the secure channel is assigned to a active session
   * @property hasSession
   * @type {Boolean}
   */
  get hasSession() {
    const self = this;
    return Object.keys(self.sessionTokens).length > 0;
  }

  /**
   * The unique hash key to identify this secure channel
   * @property hashKey
   * @type {String}
   */
  get hashKey() {
    const self = this;
    return self.securityToken.secureChannelId.toString();
  }


  setSecurity(securityMode, securityPolicy) {
    const self = this;
    // TODO verify that the endpoint really supports this mode

    self.messageBuilder.setSecurity(securityMode, securityPolicy);
  }

  /**
   * @method getCertificate
   * @return {Buffer} the X509 DER form certificate
   */
  getCertificateChain() {
    assert(this.parent, "expecting a valid parent");
    return this.parent.getCertificateChain();
  }

  /**
   * @method getCertificate
   * @return {Buffer} the X509 DER form certificate
   */
  getCertificate() {
    assert(this.parent, "expecting a valid parent");
    return this.parent.getCertificate();
  }

  getSignatureLength() {
    const self = this;
    const chain = self.getCertificateChain();
    const s = split_der(chain)[0];
    const cert = crypto_utils.exploreCertificate(s);
    return cert.publicKeyLength; // 1024 bits = 128Bytes or 2048=256Bytes
  }

  /**
   * @method getPrivateKey
   * @return {Buffer} the privateKey
   */
  getPrivateKey() {
    return this.parent ? this.parent._privateKey : null;
  }

  _add_new_security_token() {
    // The  Server  has  to accept requests secured with the old SecurityToken  until that  SecurityToken  expires
    // or until it receives a  Message  from the  Client  secured with the new  SecurityToken.
    const self = this;

    _stop_security_token_watch_dog.call(self);
    self.lastTokenId += 1;

    const securityToken = new ChannelSecurityToken({
      secureChannelId: self.secureChannelId,
      tokenId: self.lastTokenId, // todo ?
      createdAt: new Date(), // now
      revisedLifeTime: self.revisedLifeTime
    });

    assert(!securityToken.expired);
    assert(_.isFinite(securityToken.revisedLifeTime));

    self.securityToken = securityToken;

    debugLog("SecurityToken", securityToken.tokenId);

    _start_security_token_watch_dog.call(self);
  }

  _cleanup_pending_timers() {
    const self = this;

    // there is no need for the security token expiration event to trigger anymore
    _stop_security_token_watch_dog.call(self);

    _stop_open_channel_watch_dog.call(self);
  }

  /**
   * @method init
   * @async
   * @param socket {Socket}
   * @param callback {Function}
   */
  init(socket, callback) {
    const self = this;


    self.transport = new ServerTCP_transport();
    self.transport.timeout = self.timeout;

    self.transport.init(socket, (err) => {
      if (err) {
        callback(err);
      } else {
        // bind low level TCP transport to messageBuilder
        self.transport.on("message", (message_chunk) => {
          assert(self.messageBuilder);
          self.messageBuilder.feed(message_chunk);
        });
        debugLog("ServerSecureChannelLayer : Transport layer has been initialized ");
        debugLog("... now waiting for OpenSecureChannelRequest...");
        _wait_for_open_secure_channel_request.call(self, callback, self.timeout);
      }
    });

    // detect transport closure
    self._transport_socket_close_listener = (err) => {
      self._abort();
    };
    self.transport.on("socket_closed", self._transport_socket_close_listener);
  }

  _rememberClientAddressAndPort() {
    if (this.transport._socket) {
      this._remoteAddress = this.transport._socket.remoteAddress;
      this._remotePort = this.transport._socket.remotePort;
    }
  }

  _get_security_options_for_OPN() {
    const self = this;
    const cryptoFactory = self.messageBuilder.cryptoFactory;
    const options = {};
    // install sign & sign-encrypt behavior
    if (self.securityMode === MessageSecurityMode.SIGN || self.securityMode === MessageSecurityMode.SIGNANDENCRYPT) {
      assert(cryptoFactory, "ServerSecureChannelLayer must have a crypto strategy");

      options.signatureLength = self.getSignatureLength();

      options.signingFunc = (chunk) => {
        const signed = cryptoFactory.asymmetricSign(chunk, self.getPrivateKey());
        assert(signed.length === options.signatureLength);
        return signed;
      };

      assert(self.receiverPublicKeyLength >= 0);
      options.plainBlockSize = self.receiverPublicKeyLength - cryptoFactory.blockPaddingSize;
      options.cipherBlockSize = self.receiverPublicKeyLength;

      options.encrypt_buffer = chunk => cryptoFactory.asymmetricEncrypt(chunk, self.receiverPublicKey);
    }
    return options;
  }

  _get_security_options_for_MSG() {
    const self = this;
    if (self.securityMode === MessageSecurityMode.NONE) {
      return null;
    }
    const cryptoFactory = self.messageBuilder.cryptoFactory;

    /* istanbul ignore next */
    if (!cryptoFactory) {
      return null;
    }

    assert(cryptoFactory, "ServerSecureChannelLayer must have a crypto strategy");
    assert(self.derivedKeys.derivedServerKeys);
    const derivedServerKeys = self.derivedKeys.derivedServerKeys;
    return getOptionsForSymmetricSignAndEncrypt(self.securityMode, derivedServerKeys);
  }

  /**
   * @method send_response
   * @async
   * @param msgType
   * @param response
   * @param message
   * @param  {Function} [callback] an optional callback function
   */
  send_response(msgType, response, message, callback) {
    const request = message.request;
    const requestId = message.requestId;
    assert(response._schema);
    assert(request._schema);
    assert(requestId && requestId > 0);

    const self = this;

    // istanbul ignore next
    if (doDebug) {
      // verify that response for a given requestId is only sent once.
      if (!self.__verifId) {
        self.__verifId = {};
      }
      assert(!self.__verifId[requestId], " response for requestId has already been sent !! - Internal Error");
      self.__verifId[requestId] = requestId;
    }

    self.msgType = msgType;

    // record tick : send response received.
    self._tick2 = get_clock_tick();

    assert(self.securityToken);

    let options = {
      requestId,
      secureChannelId: self.securityToken.secureChannelId,
      tokenId: self.securityToken.tokenId,

      chunkSize: self.transport.receiveBufferSize

    };

    const security_options = (msgType === "OPN") ? self._get_security_options_for_OPN() : self._get_security_options_for_MSG();
    options = _.extend(options, security_options);

    assert(_.isFinite(request.requestHeader.requestHandle));

    response.responseHeader.requestHandle = request.requestHeader.requestHandle;

    /* istanbul ignore next */
    if (0 && doDebug) {
      console.log(" options ", options);
      analyze_object_binary_encoding(response);
    }

    // xx console.log(" sending request ".bgWhite.red,requestId,message.request.constructor.name);

    /* istanbul ignore next */
    if (do_trace_message) {
      console.log("xxxx   >>>> ---------------------------------------- ".cyan.bold, response._schema.name.green.bold, requestId);
      console.log(response.toString());
      console.log("xxxx   >>>> ----------------------------------------|\n".cyan.bold);
    }

    if (self._on_response) {
      self._on_response(msgType, response, message);
    }

    self._transactionsCount += 1;
    self.messageChunker.chunkSecureMessage(msgType, options, response, _send_chunk.bind(self, callback));
  }

  /**
   *
   * send a ServiceFault response
   * @method send_error_and_abort
   * @async
   * @param statusCode  {StatusCode} the status code
   * @param description {String}
   * @param message     {String}
   * @param callback    {Function}
   */
  send_error_and_abort(statusCode, description, message, callback) {
    const self = this;

    assert(statusCode instanceof StatusCode);
    assert(message.request._schema);
    assert(message.requestId && message.requestId > 0);
    assert(_.isFunction(callback));

    const response = new ServiceFault({
      responseHeader: { serviceResult: statusCode }
    });

    response.description = description;
    self.send_response("MSG", response, message, () => {
      self.close(callback);
    });
  }

  /**
   * _process_certificates extracts client public keys from client certificate
   *  and store them in self.receiverPublicKey and self.receiverCertificate
   *  it also caches self.receiverPublicKeyLength.
   *
   *  so they can be used by security channel.
   *
   * @method _process_certificates
   * @param message the message coming from the client
   * @param callback
   * @private
   * @async
   */
  _process_certificates(message, callback) {
    const self = this;

    self.receiverPublicKey = null;
    self.receiverPublicKeyLength = 0;
    self.receiverCertificate = message.securityHeader ? message.securityHeader.senderCertificate : null;

    // ignore receiverCertificate that have a zero length
    /* istanbul ignore next */
    if (self.receiverCertificate && self.receiverCertificate.length === 0) {
      self.receiverCertificate = null;
    }

    if (self.receiverCertificate) {
      // extract public key
      crypto_utils.extractPublicKeyFromCertificate(self.receiverCertificate, (err, key) => {
        if (!err) {
          self.receiverPublicKey = key;
          self.receiverPublicKeyLength = crypto_utils.rsa_length(key);
        }
        callback(err);
      });
    } else {
      self.receiverPublicKey = null;
      callback();
    }
  }

  _abort() {
    const self = this;
    if (self._abort_has_been_called) {
      return;
    }
    self._abort_has_been_called = true;

    self._cleanup_pending_timers();
    /**
     * notify the observers that the SecureChannel has aborted.
     * the reason could be :
     *   - a CloseSecureChannelRequest has been received.
     *   - a invalid message has been received
     * the event is sent after the underlying transport layer has been closed.
     *
     * @event abort
     */
    self.emit("abort");
  }

  /**
   * Abruptly close a Server SecureChannel ,by terminating the underlying transport.
   *
   *
   * @method close
   * @async
   * @param callback {Function}
   */
  close(callback) {
    debugLog("ServerSecureChannelLayer#close");
    const self = this;
    // close socket
    self.transport.disconnect(() => {
      self._abort();
      if (_.isFunction(callback)) {
        callback();
      }
    });
  }

  _record_transaction_statistics() {
    const self = this;
    self._bytesRead_before = self._bytesRead_before || 0;
    self._byesWritten_before = self._byesWritten_before || 0;

    self.last_transaction_stats = {
      bytesRead: self.bytesRead - self._bytesRead_before,
      bytesWritten: self.bytesWritten - self._bytesWritten_before,
      lap_reception: self._tick1 - self._tick0,
      lap_processing: self._tick2 - self._tick1,
      lap_emission: self._tick3 - self._tick2,
      //last_transaction_time: Date.now()
    };

    // final operation in statistics
    self._bytesRead_before = self.bytesRead;
    self._bytesWritten_before = self.bytesWritten;
  }

  _dump_transaction_statistics() {
    const self = this;
    console.log("                Bytes Read : ", self.last_transaction_stats.bytesRead);
    console.log("             Bytes Written : ", self.last_transaction_stats.bytesWritten);
    console.log("   time to receive request : ", self.last_transaction_stats.lap_reception / 1000, " sec");
    console.log("   time to process request : ", self.last_transaction_stats.lap_processing / 1000, " sec");
    console.log("   time to send response   : ", self.last_transaction_stats.lap_emission / 1000, " sec");
  }

  has_endpoint_for_security_mode_and_policy(securityMode, securityPolicy) {
    const self = this;
    if (!self.endpoints) {
      return true;
    }
    const endpoint_desc = self.endpoints.getEndpointDescription(securityMode, securityPolicy);
    return (endpoint_desc !== null);
  }
}


function _stop_security_token_watch_dog() {
  /* jshint validthis: true */
  const self = this;

  if (self._securityTokenTimeout) {
    clearTimeout(self._securityTokenTimeout);
    self._securityTokenTimeout = null;
  }
}

function _start_security_token_watch_dog() {
  /* jshint validthis: true */
  const self = this;

  // install securityToken timeout watchdog
  self._securityTokenTimeout = setTimeout(() => {
    console.log(" Security token has really expired and shall be discarded !!!!");
    console.log(" Server will now refuse message with token ", self.securityToken.tokenId);
    self._securityTokenTimeout = null;
  }, self.securityToken.revisedLifeTime * 120 / 100);
}

function _prepare_security_token(openSecureChannelRequest) {
  /* jshint validthis: true */
  const self = this;
  assert(openSecureChannelRequest instanceof OpenSecureChannelRequest);

  delete self.securityToken;

  if (openSecureChannelRequest.requestType === SecurityTokenRequestType.RENEW) {
    _stop_security_token_watch_dog.call(self);
  } else if (openSecureChannelRequest.requestType === SecurityTokenRequestType.ISSUE) {
    // TODO
  } else {
    // Invalid requestType
  }

  self._add_new_security_token();
}

function _set_lifetime(requestedLifetime) {
  /* jshint validthis: true */
  const self = this;

  assert(_.isFinite(requestedLifetime));


  // revised lifetime
  self.revisedLifeTime = requestedLifetime;
  if (self.revisedLifeTime === 0) {
    self.revisedLifeTime = self.defaultSecureTokenLifetime;
  } else {
    self.revisedLifeTime = Math.min(self.defaultSecureTokenLifetime, self.revisedLifeTime);
  }
}

function _stop_open_channel_watch_dog() {
  /* jshint validthis: true */
  const self = this;

  if (self.timeoutId) {
    clearTimeout(self.timeoutId);
    self.timeoutId = null;
  }
}


function _cancel_wait_for_open_secure_channel_request_timeout() {
  /* jshint validthis: true */
  const self = this;

  assert(self);
  // suspend timeout handler
  clearTimeout(self.timeoutId);
  self.timeoutId = null;
}

function _install_wait_for_open_secure_channel_request_timeout(callback, timeout) {
  /* jshint validthis: true */
  const self = this;

  assert(_.isFinite(timeout));
  assert(_.isFunction(callback));
  assert(self);

  self.timeoutId = setTimeout(() => {
    self.timeoutId = null;
    const err = new Error(`Timeout waiting for OpenChannelRequest (timeout was ${timeout} ms)`);
    debugLog(err.message);
    self.close(() => {
      callback(err);
    });
  }, timeout);
}

function _on_initial_open_secure_channel_request(callback, request, msgType, requestId, secureChannelId) {
  /* istanbul ignore next */
  if (do_trace_message) {
    dump_request(request, requestId, secureChannelId);
  }

  assert(_.isFunction(callback));
  /* jshint validthis: true */
  const self = this;

  assert(self);

  // check that the request is a OpenSecureChannelRequest
  /* istanbul ignore next */
  if (doDebug) {
    debugLog(self.messageBuilder.sequenceHeader.toString());
    debugLog(self.messageBuilder.securityHeader.toString());
    // xx analyze_object_binary_encoding(request);
  }

  _cancel_wait_for_open_secure_channel_request_timeout.call(self);

  requestId = self.messageBuilder.sequenceHeader.requestId;
  assert(requestId > 0);

  const message = {
    request,
    securityHeader: self.messageBuilder.securityHeader,
    requestId
  };
  assert(message.requestId === requestId);

  self.clientSecurityHeader = message.securityHeader;

  _on_initial_OpenSecureChannelRequest.call(self, message, callback);
}

function _wait_for_open_secure_channel_request(callback, timeout) {
  /* jshint validthis: true */
  const self = this;
  _install_wait_for_open_secure_channel_request_timeout.call(self, callback, timeout);
  self.messageBuilder.once("message", _on_initial_open_secure_channel_request.bind(self, callback));
}

function _send_chunk(callback, messageChunk) {
  /* jshint validthis: true */
  const self = this;

  if (messageChunk) {
    self.transport.write(messageChunk);
  } else {
    // record tick 3 : transaction completed.
    self._tick3 = get_clock_tick();

    if (callback) {
      setImmediate(callback);
    }

    self._record_transaction_statistics();

    /* istanbul ignore next */
    if (doDebug) {
      // dump some statistics about transaction ( time and sizes )
      self._dump_transaction_statistics();
    }

    self.emit("transaction_done");
  }
}


/**
 * @method _prepare_security_header
 * @param request
 * @param message
 * @return {AsymmetricAlgorithmSecurityHeader}
 * @private
 */
function _prepare_security_header(request, message) {
  /* jshint validthis: true */
  const self = this;
  let securityHeader = null;
  // senderCertificate:
  //    The X509v3 certificate assigned to the sending application instance.
  //    This is a DER encoded blob.
  //    This indicates what private key was used to sign the MessageChunk.
  //    This field shall be null if the message is not signed.
  // receiverCertificateThumbprint:
  //    The thumbprint of the X509v3 certificate assigned to the receiving application
  //    The thumbprint is the SHA1 digest of the DER encoded form of the certificate.
  //    This indicates what public key was used to encrypt the MessageChunk
  //   This field shall be null if the message is not encrypted.
  switch (request.securityMode.value) {
    case MessageSecurityMode.NONE.value:
      assert(!message.securityHeader || message.securityHeader.securityPolicyUri === "http://opcfoundation.org/UA/SecurityPolicy#None");
      securityHeader = new AsymmetricAlgorithmSecurityHeader({
        securityPolicyUri: "http://opcfoundation.org/UA/SecurityPolicy#None",
        senderCertificate: null, // message not signed
        receiverCertificateThumbprint: null // message not encrypted
      });

      break;
    case MessageSecurityMode.SIGN.value:
    case MessageSecurityMode.SIGNANDENCRYPT.value:

      // get the thumbprint of the client certificate
      const thumbprint = self.receiverCertificate ? crypto_utils.makeSHA1Thumbprint(self.receiverCertificate) : null;

      securityHeader = new AsymmetricAlgorithmSecurityHeader({
        securityPolicyUri: self.clientSecurityHeader.securityPolicyUri,
        senderCertificate: self.getCertificateChain(), // certificate of the private key used to sign the message
        receiverCertificateThumbprint: thumbprint // message not encrypted (????)
      });
      break;
  }
  return securityHeader;
}


function _handle_OpenSecureChannelRequest(message, callback) {
  /* jshint validthis: true */
  const self = this;

  const request = message.request;
  const requestId = message.requestId;
  assert(request._schema.name === "OpenSecureChannelRequest");
  assert(requestId && requestId > 0);

  self.clientNonce = request.clientNonce;

  _set_lifetime.call(self, request.requestedLifetime);

  _prepare_security_token.call(self, request);


  let serviceResult = StatusCodes.Good;

  const cryptoFactory = self.messageBuilder.cryptoFactory;
  if (cryptoFactory) {
    // serverNonce: A random number that shall not be used in any other request. A new
    //    serverNonce shall be generated for each time a SecureChannel is renewed.
    //    This parameter shall have a length equal to key size used for the symmetric
    //    encryption algorithm that is identified by the securityPolicyUri.
    self.serverNonce = crypto.randomBytes(cryptoFactory.symmetricKeyLength);

    if (self.clientNonce.length !== self.serverNonce.length) {
      console.log("warning client Nonce length doesn't match server nonce length".red, self.clientNonce.length, " !=", self.serverNonce.length);
      // what can we do
      // - just ignore it ?
      // - or adapt serverNonce length to clientNonce Length ?
      // xx self.serverNonce = crypto.randomBytes(self.clientNonce.length);
      // - or adapt clientNonce length to serverNonce Length ?
      // xx self.clientNonce = self.clientNonce.slice(0,self.serverNonce.length);
      //
      // - or abort connection ? << LET BE SAFE AND CHOOSE THIS ONE !
      serviceResult = StatusCodes.BadSecurityModeRejected; // ToDo check code
    }
    // expose derivedKey to use for symmetric sign&encrypt
    // to help us decrypting and verifying messages received from client
    self.derivedKeys = cryptoFactory.compute_derived_keys(this.serverNonce, this.clientNonce);
  }

  const derivedClientKeys = this.derivedKeys ? this.derivedKeys.derivedClientKeys : null;
  this.messageBuilder.pushNewToken(this.securityToken, derivedClientKeys);

  // let prepare self.securityHeader;
  self.securityHeader = _prepare_security_header.call(self, request, message);
  assert(self.securityHeader);

  const derivedServerKeys = self.derivedKeys ? self.derivedKeys.derivedServerKeys : null;

  self.messageChunker.update({

    // for OPN
    securityHeader: self.securityHeader,

    // derived keys for symmetric encryption of standard MSG
    // to sign and encrypt MSG sent to client
    derivedKeys: derivedServerKeys
  });

  let response = new OpenSecureChannelResponse({
    responseHeader: {
      serviceResult
    },
    serverProtocolVersion: self.protocolVersion,
    securityToken: self.securityToken,
    serverNonce: self.serverNonce
  });

  // get the clientCertificate from message securityHeader
  // for convenience
  self.clientCertificate = message.securityHeader ? message.securityHeader.senderCertificate : null;

  // If the SecurityMode is not None then the Server shall verify that a SenderCertificate and a
  // ReceiverCertificateThumbprint were specified in the SecurityHeader.
  if (self.securityMode.value !== MessageSecurityMode.NONE.value) {
    if (!_check_receiverCertificateThumbprint.call(self, self.clientSecurityHeader)) {
      var description = "Server#OpenSecureChannelRequest : Invalid receiver certificate thumbprint : the thumbprint doesn't match server certificate !";
      console.log(description.cyan);
      response.responseHeader.serviceResult = StatusCodes.BadCertificateInvalid;
    }
  }

  if (self.clientCertificate) {
    const certificate_status = _check_certificate_validity(self.clientCertificate);
    if (StatusCodes.Good !== certificate_status) {
      description = "Sender Certificate Error";
      console.log(description.cyan, certificate_status.toString().bgRed.yellow);
      // OPCUA specification v1.02 part 6 page 42 $6.7.4
      // If an error occurs after the  Server  has verified  Message  security  it  shall  return a  ServiceFault  instead
      // of a OpenSecureChannel  response. The  ServiceFault  Message  is described in  Part  4,   7.28.
      response = new ServiceFault({ responseHeader: { serviceResult: certificate_status } });
    }
  }

  self.send_response("OPN", response, message, () => /* err*/ {
    // console.log(err);
    if (response.responseHeader.serviceResult !== StatusCodes.Good) {
      self.close();
    }
    callback(null);
  });
}


// istanbul ignore next
function dump_request(request, requestId, secureChannelId) {
  console.log("xxxx   <<<< ---------------------------------------- ".cyan, request._schema.name.yellow, "requestId", requestId, "secureChannelId=", secureChannelId);
  console.log(request.toString());
  console.log("xxxx   <<<< ---------------------------------------- \n".cyan);
}

const _on_common_message = function (request, msgType, requestId, secureChannelId) {
  const self = this;

  /* istanbul ignore next */
  if (do_trace_message) {
    dump_request(request, requestId, secureChannelId);
  }

  requestId = self.messageBuilder.sequenceHeader.requestId;

  const message = {
    request,
    requestId,
    channel: self
  };

  if (msgType === "CLO" && request._schema.name === "CloseSecureChannelRequest") {
    self.close();
  } else if (msgType === "OPN" && request._schema.name === "OpenSecureChannelRequest") {
    // intercept client request to renew security Token
    _handle_OpenSecureChannelRequest.call(self, message, () => {
    });
  } else if (request._schema.name === "CloseSecureChannelRequest") {
    console.log(`WARNING : RECEIVED a CloseSecureChannelRequest with MSGTYPE=${msgType}`);
    self.close();
  } else {
    // record tick 1 : after message has been received, before message processing
    self._tick1 = get_clock_tick();

    /**
     * notify the observer that a OPCUA message has been received.
     * It is up to one observer to call send_response or send_error_and_abort to complete
     * the transaction.
     *
     * @event message
     * @param message
     */
    self.emit("message", message);
  }
};

/**
 * @method _check_receiverCertificateThumbprint
 * verify that the receiverCertificateThumbprint send by the client
 * matching the CertificateThumbPrint of the server
 * @param clientSecurityHeader
 * @return {boolean}
 * @private
 */
function _check_receiverCertificateThumbprint(clientSecurityHeader) {
  /* jshint validthis: true */
  const self = this;
  if (clientSecurityHeader.receiverCertificateThumbprint) {
    // check if the receiverCertificateThumbprint is my certificate thumbprint
    const serverCertificateChain = self.getCertificateChain();
    const serverCertificate = split_der(serverCertificateChain)[0];
    const myCertificateThumbPrint = crypto_utils.makeSHA1Thumbprint(serverCertificateChain);
    // xx console.log("xxxx     my certificate thumbprint",myCertificateThumbPrint.toString("hex") );
    // xx console.log("xxxx receiverCertificateThumbprint",securityHeader.receiverCertificateThumbprint.toString("hex") );
    return myCertificateThumbPrint.toString("hex") === clientSecurityHeader.receiverCertificateThumbprint.toString("hex");
  }
  return true;
}


// Bad_CertificateHostNameInvalid            The HostName used to connect to a Server does not match a HostName in the
//                                           Certificate.
// Bad_CertificateIssuerRevocationUnknown    It was not possible to determine if the Issuer Certificate has been revoked.
// Bad_CertificateIssuerUseNotAllowed        The Issuer Certificate may not be used for the requested operation.
// Bad_CertificateIssuerTimeInvalid          An Issuer Certificate has expired or is not yet valid.
// Bad_CertificateIssuerRevoked              The Issuer Certificate has been revoked.
// Bad_CertificateInvalid                    The certificate provided as a parameter is not valid.
// Bad_CertificateRevocationUnknown          It was not possible to determine if the Certificate has been revoked.
// Bad_CertificateRevoked                    The Certificate has been revoked.
// Bad_CertificateTimeInvalid                The Certificate has expired or is not yet valid.
// Bad_CertificateUriInvalid                 The URI specified in the ApplicationDescription does not match the URI in the Certificate.
// Bad_CertificateUntrusted                  The Certificate is not trusted.
// Bad_CertificateUseNotAllowed              The Certificate may not be used for the requested operation.

// also see OPCUA 1.02 part 4 :
//  - page 95  6.1.3 Determining if a Certificate is Trusted
// -  page 100 6.2.3 Validating a Software Certificate
//
function _check_certificate_validity(certificate) {
  // Is the  signature on the SoftwareCertificate valid .?
  if (!certificate) {
    // missing certificate
    return StatusCodes.BadSecurityChecksFailed;
  }

  // -- var split_der = require("lib/misc/crypto_explore_certificate").split_der;
  // -- var chain = split_der(securityHeader.senderCertificate);
  // -- //xx console.log("xxx NB CERTIFICATE IN CHAIN = ".red,chain.length);

  // Has SoftwareCertificate passed its issue date and has it not expired ?
  // check dates
  const cert = crypto_utils.exploreCertificate(certificate);

  const now = new Date();

  if (cert.notBefore.getTime() > now.getTime()) {
    // certificate is not active yet
    console.log(`${" Sender certificate is invalid : certificate is not active yet !".red}  not before date =${cert.notBefore}`);
    return StatusCodes.BadCertificateTimeInvalid;
  }
  if (cert.notAfter.getTime() <= now.getTime()) {
    // certificate is obsolete
    console.log(`${" Sender certificate is invalid : certificate has expired !".red} not after date =${cert.notAfter}`);
    return StatusCodes.BadCertificateTimeInvalid;
  }

  // Has SoftwareCertificate has  been revoked by the issuer ?
  // TODO: check if certificate is revoked or not ...
  // StatusCodes.BadCertificateRevoked

  // is issuer Certificate  valid and has not been revoked by the CA that issued it. ?
  // TODO : check validity of issuer certificate
  // StatusCodes.BadCertificateIssuerRevoked

  // does the URI specified in the ApplicationDescription  match the URI in the Certificate ?
  // TODO : check ApplicationDescription of issuer certificate
  // return StatusCodes.BadCertificateUriInvalid

  return StatusCodes.Good;
}

// Bad_RequestTypeInvalid     The security token request type is not valid.
// Bad_SecurityModeRejected   The security mode does not meet the requirements set by the Server.
// Bad_SecurityPolicyRejected The security policy does not meet the requirements set by the Server.
// Bad_SecureChannelIdInvalid
// Bad_NonceInvalid

function isValidSecurityPolicy(securityPolicy) {
  switch (securityPolicy.value) {
    case SecurityPolicy.None.value:
    case SecurityPolicy.Basic128Rsa15.value:
    case SecurityPolicy.Basic256.value:
      return StatusCodes.Good;
    default:
      return StatusCodes.BadSecurityPolicyRejected;
  }
}

function _send_error(statusCode, description, message, callback) {
  /* jshint validthis: true */
  const self = this;

  // turn of security mode as we haven't manage to set it to
  self.securityMode = MessageSecurityMode.NONE;

  // unexpected message type ! let close the channel
  const err = new Error(description);
  self.send_error_and_abort(statusCode, description, message, () => {
    callback(err); // OK
  });
}
function _on_initial_OpenSecureChannelRequest(message, callback) {
  assert(_.isFunction(callback));

  /* jshint validthis: true */
  const self = this;

  const request = message.request;
  const requestId = message.requestId;

  assert(requestId > 0);
  assert(_.isFinite(request.requestHeader.requestHandle));
  let description;

  // expecting a OpenChannelRequest as first communication message
  if (!(request instanceof OpenSecureChannelRequest)) {
    description = "Expecting OpenSecureChannelRequest";
    console.log("ERROR".red, "BadCommunicationError: expecting a OpenChannelRequest as first communication message");
    return _send_error.call(this, StatusCodes.BadCommunicationError, description, message, callback);
  }

  const securityPolicy = fromURI(message.securityHeader.securityPolicyUri);

  // check security header
  const check_security_policy = isValidSecurityPolicy(securityPolicy);
  if (check_security_policy !== StatusCodes.Good) {
    description = ` Unsupported securityPolicyUri ${self.messageBuilder.securityHeader.securityPolicyUri}`;
    return _send_error.call(this, check_security_policy, description, message, callback);
  }

  assert(request.securityMode);
  self.securityMode = request.securityMode;
  self.messageBuilder.securityMode = self.securityMode;

  const has_endpoint = self.has_endpoint_for_security_mode_and_policy(self.securityMode, securityPolicy);

  if (!has_endpoint) {
    // there is no
    description = ` This server doesn't not support  ${securityPolicy.toString()} ${self.securityMode.toString()}`;
    return _send_error.call(self, StatusCodes.BadSecurityPolicyRejected, description, message, callback);
  }

  self.endpoint = self.endpoints && self.endpoints.getEndpointDescription(self.securityMode, securityPolicy);


  self.messageBuilder
    .on("message", _on_common_message.bind(self))
    .on("start_chunk", () => {
      // record tick 0: when the first chunk is received
      self._tick0 = get_clock_tick();
    });

  // handle initial OpenSecureChannelRequest
  self._process_certificates(message, () => {
    _handle_OpenSecureChannelRequest.call(self, message, callback);
  });
}


export default ServerSecureChannelLayer;