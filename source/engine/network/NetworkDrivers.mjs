import Cvar from '../common/Cvar.mjs';
import { HostError } from '../common/Errors.mjs';
import { eventBus, registry } from '../registry.mjs';

let { COM, Con, NET, Sys, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  NET = registry.NET;
  Sys = registry.Sys;
  SV = registry.SV;
});

export class QSocket {
  static STATE_NEW = 'new';
  static STATE_CONNECTING = 'connecting';
  static STATE_CONNECTED = 'connected';
  static STATE_DISCONNECTING = 'disconnecting';
  static STATE_DISCONNECTED = 'disconnected';

  constructor(time, driver) {
    this.connecttime = time;
    this.lastMessageTime = time;
    this.driver = driver;
    this.address = null;
    this.state = QSocket.STATE_NEW;

    this.receiveMessage = new Uint8Array(new ArrayBuffer(8192));
    this.receiveMessageLength = 0;

    this.sendMessage = new Uint8Array(new ArrayBuffer(8192));
    this.sendMessageLength = 0;
  }

  toString() {
    return `QSocket(${this.address}, ${this.state})`;
  }

  /**
   *
   * @returns {BaseDriver} the driver for this socket
   */
  _getDriver() {
    console.assert(NET.drivers[this.driver], 'QSocket needs a valid driver');

    return NET.drivers[this.driver]; // FIXME: global ref
  }

  GetMessage() {
    return this._getDriver().GetMessage(this);
  }

  SendMessage(data) {
    return this._getDriver().SendMessage(this, data);
  }

  SendUnreliableMessage(data) {
    return this._getDriver().SendUnreliableMessage(this, data);
  }

  CanSendMessage() {
    return this._getDriver().CanSendMessage(this);
  }

  Close() {
    return this._getDriver().Close(this);
  }
};

export class BaseDriver {
  constructor() {
    this.initialized = false;
    this.driverlevel = null;
  }

  Init(driverlevel) {
    this.driverlevel = driverlevel;
    return false;
  }

  // eslint-disable-next-line no-unused-vars
  Connect(host) {
    return null;
  }

  CheckNewConnections() {
    return null;
  }

  CheckForResend() {
    return -1;
  }

  // eslint-disable-next-line no-unused-vars
  GetMessage(qsocket) {
    return -1;
  }

  // eslint-disable-next-line no-unused-vars
  SendMessage(qsocket, data) {
    return -1;
  }

  // eslint-disable-next-line no-unused-vars
  SendUnreliableMessage(qsocket, data) {
    return -1;
  }

  // eslint-disable-next-line no-unused-vars
  CanSendMessage(qsocket) {
    return false;
  }

  Close(qsocket) {
    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  /**
   * Determine if this driver should handle listening in the current environment
   * @returns {boolean} true if this driver should listen
   */
  ShouldListen() {
    return true; // Default: always listen
  }

  Listen() {
  }
};

export class LoopDriver extends BaseDriver {
  constructor() {
    super();
    this._server = null;
    this._client = null;
    this.localconnectpending = false;
  }

  Init(driverlevel) {
    this.driverlevel = driverlevel;

    this._server = null;
    this._client = null;
    this.localconnectpending = false;

    this.initialized = true;
    return true;
  }

  Connect(host) {
    if (host !== 'local') { // Loop Driver only handles loopback/local connections
      return null;
    }

    // we will return only one new client ever
    this.localconnectpending = true;

    if (this._server === null) {
      this._server = NET.NewQSocket();
      this._server.driver = this.driverlevel;
      this._server.address = 'local server';
    }

    this._server.receiveMessageLength = 0;
    this._server.canSend = true;

    if (this._client === null) {
      this._client = NET.NewQSocket();
      this._client.driver = this.driverlevel;
      this._client.address = 'local client';
    }

    this._client.receiveMessageLength = 0;
    this._client.canSend = true;

    this._server.driverdata = this._client; // client is directly feeding into the server
    this._client.driverdata = this._server; // and vice-versa

    this._client.state = QSocket.STATE_CONNECTED;
    this._server.state = QSocket.STATE_CONNECTED;

    return this._server;
  }

  CheckNewConnections() {
    if (!this.localconnectpending) {
      return null;
    }

    this.localconnectpending = false;

    this._client.receiveMessageLength = 0;
    this._client.canSend = true;
    this._client.state = QSocket.STATE_CONNECTED;

    this._server.receiveMessageLength = 0;
    this._server.canSend = true;
    this._server.state = QSocket.STATE_CONNECTED;

    return this._client;
  }

  GetMessage(sock) {
    if (sock.receiveMessageLength === 0) {
      return 0;
    }
    const ret = sock.receiveMessage[0];
    const length = sock.receiveMessage[1] + (sock.receiveMessage[2] << 8);
    if (length > NET.message.data.byteLength) {
      throw new HostError('Loop.GetMessage: overflow');
    }
    NET.message.cursize = length;
    new Uint8Array(NET.message.data).set(sock.receiveMessage.subarray(3, length + 3));
    sock.receiveMessageLength -= length;
    if (sock.receiveMessageLength >= 4) {
      sock.receiveMessage.copyWithin(0, length + 3, length + 3 + sock.receiveMessageLength);
    }
    sock.receiveMessageLength -= 3;
    if (sock.driverdata && ret === 1) {
      sock.driverdata.canSend = true;
    }
    if (sock.state === QSocket.STATE_DISCONNECTED) {
      return -1;
    }
    return ret;
  }

  SendMessage(sock, data) {
    if (!sock.driverdata) {
      return -1;
    }
    const bufferLength = sock.driverdata.receiveMessageLength;
    sock.driverdata.receiveMessageLength += data.cursize + 3;
    if (sock.driverdata.receiveMessageLength > 8192) {
      throw new HostError('LoopDriver.SendMessage: overflow');
    }
    const buffer = sock.driverdata.receiveMessage;
    buffer[bufferLength] = 1;
    buffer[bufferLength + 1] = data.cursize & 0xff;
    buffer[bufferLength + 2] = data.cursize >> 8;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), bufferLength + 3);
    sock.canSend = false;
    return 1;
  }

  SendUnreliableMessage(sock, data) {
    if (!sock.driverdata) {
      return -1;
    }
    const bufferLength = sock.driverdata.receiveMessageLength;
    sock.driverdata.receiveMessageLength += data.cursize + 3;
    if (sock.driverdata.receiveMessageLength > 8192) {
      throw new HostError('LoopDriver.SendUnreliableMessage: overflow');
    }
    const buffer = sock.driverdata.receiveMessage;
    buffer[bufferLength] = 2;
    buffer[bufferLength + 1] = data.cursize & 0xff;
    buffer[bufferLength + 2] = data.cursize >> 8;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), bufferLength + 3);
    return 1;
  }

  CanSendMessage(sock) {
    return sock.driverdata ? sock.canSend : false;
  }

  Close(sock) {
    if (sock.driverdata) {
      sock.driverdata.driverdata = null;
    }
    sock.receiveMessageLength = 0;
    sock.canSend = false;
    if (sock === this._server) {
      this._server = null;
    } else {
      this._client = null;
    }
    sock.state = QSocket.STATE_DISCONNECTED;
  }

  Listen() {
  }
};

export class WebSocketDriver extends BaseDriver {
  Init(driverlevel) {
    super.Init(driverlevel);
    this.initialized = true;
    this.newConnections = [];
    return true;
  }

  Connect(host) {
    // Only handle ws:// and wss:// URLs
    if (!/^wss?:\/\//i.test(host)) {
      return null;
    }

    const url = new URL(host);

    // set a default port
    if (!url.port) {
      url.port = (new URL(location.href)).port;
    }

    // we can open a QSocket
    const sock = NET.NewQSocket(); // TODO: what about (NET.time, this.driverlevel);

    try {
      sock.address = url.toString();
      sock.driverdata = new WebSocket(url, 'quake');
      sock.driverdata.binaryType = 'arraybuffer';
    } catch (e) {
      Con.PrintError(`WebSocketDriver.Connect: failed to setup ${url}, ${e.message}\n`);
      return null;
    }

    // these event handlers will feed into the message buffer structures
    sock.driverdata.onerror = this._OnErrorClient;
    sock.driverdata.onmessage = this._OnMessageClient;
    sock.driverdata.onopen = this._OnOpenClient;
    sock.driverdata.onclose = this._OnCloseClient;

    // freeing up some QSocket structures
    sock.receiveMessage = [];
    sock.receiveMessageLength = null;
    sock.sendMessage = [];
    sock.sendMessageLength = null;

    sock.driverdata.qsocket = sock;

    sock.state = QSocket.STATE_CONNECTING;

    return sock;
  }

  CanSendMessage(qsocket) {
    return ![2, 3].includes(qsocket.driverdata.readyState); // FIXME: WebSocket declaration
    // return ![WebSocket.CLOSING, WebSocket.CLOSED].includes(qsocket.driverdata.readyState);
  }

  GetMessage(qsocket) {
    // check if we have collected new data
    if (qsocket.receiveMessage.length === 0) {
      if (qsocket.state === QSocket.STATE_DISCONNECTED) {
        return -1;
      }

      // finished message buffer draining due to a disconnect
      if (qsocket.state === QSocket.STATE_DISCONNECTING) {
        qsocket.state = QSocket.STATE_DISCONNECTED;
      }

      return 0;
    }

    // fetch a message
    const message = qsocket.receiveMessage.shift();

    // parse header
    const ret = message[0];
    const length = message[1] + (message[2] << 8);

    // copy over the payload to our NET.message buffer
    new Uint8Array(NET.message.data).set(message.subarray(3, length + 3));
    NET.message.cursize = length;

    return ret;
  }

  _FlushSendBuffer(qsocket) {
    switch (qsocket.driverdata.readyState) {
      case 2:
      case 3:
      // case WebSocket.CLOSING: // FIXME: WebSocket declaration
      // case WebSocket.CLOSED: // FIXME: WebSocket declaration
        Con.DPrint(`WebSocketDriver._FlushSendBuffer: connection already died (readyState = ${qsocket.driverdata.readyState})`);
        return false;

      case 0:
      // case WebSocket.CONNECTING: // still connecting // FIXME: WebSocket declaration
        return true;
    }

    while (qsocket.sendMessage.length > 0) {
      const message = qsocket.sendMessage.shift();

      if (NET.delay_send.value === 0) {
        (qsocket.driverdata).send(message);
      } else {
        setTimeout(() => {
          /** @type {WebSocket} */(qsocket.driverdata).send(message);

          // failed to send? immediately mark it as disconnected
          if (qsocket.driverdata.readyState > 1) {
            qsocket.state = QSocket.STATE_DISCONNECTED;
          }
        }, NET.delay_send.value + (Math.random() - 0.5) * NET.delay_send_jitter.value);
      }
    }

    return true;
  }

  _SendRawMessage(qsocket, data) {
    // push the message onto the sendMessage buffer
    qsocket.sendMessage.push(data);

    // try sending all out, don’t wait for an immediate reaction
    this._FlushSendBuffer(qsocket);

    // we always assume it worked
    return qsocket.state !== QSocket.STATE_DISCONNECTED ? 1 : -1;
  }

  SendMessage(qsocket, data) {
    const buffer = new Uint8Array(data.cursize + 3);
    let i = 0;
    buffer[i++] = 1;
    buffer[i++] = data.cursize & 0xff;
    buffer[i++] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), i);
    return this._SendRawMessage(qsocket, buffer);
  }

  SendUnreliableMessage(qsocket, data) {
    const buffer = new Uint8Array(data.cursize + 3);
    let i = 0;
    buffer[i++] = 2;
    buffer[i++] = data.cursize & 0xff;
    buffer[i++] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), i);
    return this._SendRawMessage(qsocket, buffer);
  }

  Close(qsocket) {
    if (this.CanSendMessage(qsocket)) {
      this._FlushSendBuffer(qsocket); // make sure to send everything queued up out
      qsocket.driverdata.close(1000);
    }

    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  // eslint-disable-next-line no-unused-vars
  _OnErrorClient(error) {
    Con.PrintError(`WebSocketDriver._OnErrorClient: lost connection to ${this.qsocket.address}\n`);
    this.qsocket.state = QSocket.STATE_DISCONNECTED; // instant disconnect
  }

  _OnMessageClient(message) {
    const data = message.data;

    if (typeof(data) === 'string') {
      return;
    }

    if (NET.delay_receive.value === 0) {
      this.qsocket.receiveMessage.push(new Uint8Array(data));
      return;
    }

    setTimeout(() => {
      this.qsocket.receiveMessage.push(new Uint8Array(data));
    }, NET.delay_receive.value + (Math.random() - 0.5) * NET.delay_receive_jitter.value);
  }

  _OnOpenClient() {
    this.qsocket.state = QSocket.STATE_CONNECTED;
  }

  _OnCloseClient() {
    if (this.qsocket.state !== QSocket.STATE_CONNECTED) {
      return;
    }

    Con.Print('WebSocketDriver._OnCloseClient: connection closed.\n');
    this.qsocket.state = QSocket.STATE_DISCONNECTING; // mark it as disconnecting, so that we can peacefully process any buffered messages
  }

  _OnConnectionServer(ws, req) {
    Con.DPrint('WebSocketDriver._OnConnectionServer: received new connection\n');

    const sock = NET.NewQSocket();

    if (!sock) {
      Con.PrintError('WebSocketDriver._OnConnectionServer: failed to allocate new socket, dropping client\n');
      // TODO: send a proper good bye to the client?
      ws.close();
      return;
    }

    sock.driver = this.driverlevel;
    sock.driverdata = ws;
    sock.address = NET.FormatIP((req.headers['x-forwarded-for'] || req.socket.remoteAddress), req.socket.remotePort);

    // these event handlers will feed into the message buffer structures
    sock.receiveMessage = [];
    sock.receiveMessageLength = null;
    sock.sendMessage = [];
    sock.sendMessageLength = null;
    sock.state = QSocket.STATE_CONNECTED;

    // set the last message time to now
    NET.time = Sys.FloatTime();
    sock.lastMessageTime = NET.time;

    ws.on('close', () => {
      Con.DPrint('WebSocketDriver._OnConnectionServer.disconnect: client disconnected\n');
      sock.state = QSocket.STATE_DISCONNECTED;

      eventBus.publish('net.connection.close', sock);
    });

    ws.on('error', () => {
      Con.DPrint('WebSocketDriver._OnConnectionServer.disconnect: client errored out\n');
      sock.state = QSocket.STATE_DISCONNECTED;

      eventBus.publish('net.connection.error', sock);
    });

    ws.on('message', (data) => {
      sock.receiveMessage.push(new Uint8Array(data));
    });

    this.newConnections.push(sock);

    eventBus.publish('net.connection.accepted', sock);
  }

  CheckNewConnections() {
    if (this.newConnections.length === 0) {
      return null;
    }

    return this.newConnections.shift();
  }

  /**
   * WebSocketDriver only listens in dedicated server mode
   * Browser environments cannot create WebSocket servers
   * @returns {boolean} true if should listen and can listen
   */
  ShouldListen() {
    return registry.isDedicatedServer && NET.server;
  }

  Listen(listening) {
    if (this.wss) {
      if (!listening) {
        this.wss.close();
        this.wss = null;
      }

      return;
    }

    const { WebSocket } = registry;

    this.wss = new WebSocket.WebSocketServer({server: NET.server});
    this.wss.on('connection', this._OnConnectionServer.bind(this));
    this.newConnections = [];
  }
};

/**
 * WebRTC Driver
 *
 * Peer-to-peer networking using WebRTC DataChannels.
 * Uses a signaling server for initial connection setup.
 */
export class WebRTCDriver extends BaseDriver {
  constructor() {
    super();
    this.signalingUrl = null;
    this.signalingWs = null;
    this.sessionId = null;
    this.peerId = null;
    this.isHost = false;
    this.creatingSession = false; // Track if we're in the process of creating a session
    this.pingInterval = null; // Timer for sending pings to signaling server
    /** @type {Function[]} */
    this.serverEventSubscriptions = [];
    this.newConnections = [];
    this.pendingConnections = new Map(); // peerId -> { qsocket, peerConnection }

    // STUN/TURN servers configuration
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.nextcloud.com:443' },
    ];
  }

  Init(driverlevel) {
    super.Init(driverlevel);

    // WebRTC only makes sense in browser environment
    if (registry.isDedicatedServer) {
      // Don't initialize in dedicated server mode
      this.initialized = false;
      return false;
    }

    // Determine signaling server URL
    // For local development: ws://localhost:3001/signaling
    // For production: could be wss://signaling.yourcdn.com
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

    // Try to connect to local signaling server first, fallback to same host
    this.signalingUrl = `${protocol}//${location.hostname}:8787/signaling`;

    if (registry.urlFns && typeof registry.urlFns.signalingURL === 'function') {
      this.signalingUrl = registry.urlFns.signalingURL();
    }

    this.initialized = true;
    Con.DPrint(`WebRTCDriver: Initialized with signaling at ${this.signalingUrl}\n`);
    return true;
  }

  /**
   * Connect to a WebRTC peer
   * @param {string} host - Format: "webrtc://sessionId" or just "sessionId" to join
   *                        Use "webrtc://host" or "host" to create a new session
   */
  Connect(host) {
    if (!/^webrtc:\/\//i.test(host)) {
      return null;
    }

    // Parse the host parameter
    let sessionId = null;
    let shouldCreateSession = false;

    if (host.startsWith('webrtc://')) {
      host = host.substring(9);
    }

    // "host" means create a new session, otherwise join existing
    if (host === 'host' || host === '') {
      shouldCreateSession = true;
    } else {
      sessionId = host;
    }

    // Connect to signaling server
    if (!this._ConnectSignaling()) {
      Con.PrintError('WebRTCDriver.Connect: Failed to connect to signaling server\n');
      return null;
    }

    // Create a QSocket for tracking this connection attempt
    const sock = NET.NewQSocket();
    sock.driver = this.driverlevel;
    sock.state = QSocket.STATE_CONNECTING;
    sock.address = shouldCreateSession ? 'WebRTC Host' : `WebRTC Session ${sessionId}`;

    // Store connection state
    sock.driverdata = {
      sessionId: sessionId,
      isHost: shouldCreateSession,
      peerConnections: new Map(), // peerId -> RTCPeerConnection
      dataChannels: new Map(), // peerId -> { reliable, unreliable }
      signalingReady: false,
    };

    // Free up some QSocket structures (we'll use our own buffering)
    sock.receiveMessage = [];
    sock.sendMessage = [];

    // Wait for signaling to be ready, then create or join session
    const onSignalingReady = () => {
      if (shouldCreateSession) {
        this._CreateSession(sock);
      } else {
        this._JoinSession(sock, sessionId);
      }
    };

    if (this.signalingWs && this.signalingWs.readyState === 1) {
      onSignalingReady();
    } else {
      // Store callback for when signaling connects
      sock.driverdata.onSignalingReady = onSignalingReady;
    }

    return sock;
  }

  /**
   * Connect to the signaling server
   * @returns {boolean} true if connected or connecting
   */
  _ConnectSignaling() {
    if (this.signalingWs) {
      if (this.signalingWs.readyState === 1) { // OPEN
        return true;
      }
      if (this.signalingWs.readyState === 0) { // CONNECTING
        return true;
      }
    }

    try {
      this.signalingWs = new WebSocket(this.signalingUrl);

      this.signalingWs.onopen = () => {
        Con.DPrint('WebRTCDriver: Connected to signaling server\n');
        this._ProcessPendingSignaling();
      };

      this.signalingWs.onmessage = (event) => {
        this._OnSignalingMessage(JSON.parse(event.data));
      };

      this.signalingWs.onerror = (error) => {
        Con.PrintError(`WebRTCDriver: Signaling error: ${error}\n`);
      };

      this.signalingWs.onclose = () => {
        Con.DPrint('WebRTCDriver: Signaling connection closed\n');
        this.signalingWs = null;
      };

      return true;
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Failed to connect to signaling: ${error.message}\n`);
      return false;
    }
  }

  /**
   * Process any pending signaling operations
   */
  _ProcessPendingSignaling() {
    // Call any pending onSignalingReady callbacks
    for (let i = 0; i < NET.activeSockets.length; i++) {
      const sock = NET.activeSockets[i];
      if (sock && sock.driver === this.driverlevel && sock.driverdata?.onSignalingReady) {
        sock.driverdata.onSignalingReady();
        delete sock.driverdata.onSignalingReady;
      }
    }
  }

  /**
   * Send a message to the signaling server
   * @param message
   */
  _SendSignaling(message) {
    if (this.signalingWs && this.signalingWs.readyState === 1) {
      this.signalingWs.send(JSON.stringify(message));
    }
  }

  /**
   * Start sending periodic pings to keep the session alive (host only)
   */
  _StartPingInterval() {
    if (!this.isHost) {
      return; // Only hosts need to ping
    }

    // Clear any existing interval
    this._StopPingInterval();

    // Send ping every 30 seconds
    this.pingInterval = setInterval(() => {
      this._SendSignaling({ type: 'ping' });
    }, 30 * 1000);

    // Send initial ping immediately
    this._SendSignaling({ type: 'ping' });
  }

  /**
   * Stop sending pings
   */
  _StopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Start sending periodic server info updates (host only)
   */
  _StartServerInfoSubscriptions() {
    if (!this.isHost) {
      return; // Only hosts need to update server info
    }

    // Clear any existing subscriptions
    this._StopServerInfoSubscriptions();

    this.serverEventSubscriptions.push(eventBus.subscribe('server.spawned', () => this._UpdateServerInfo()));

    this.serverEventSubscriptions.push(eventBus.subscribe('server.client.connected', () => this._UpdateServerInfo()));
    this.serverEventSubscriptions.push(eventBus.subscribe('server.client.disconnected', () => this._UpdateServerInfo()));

    this.serverEventSubscriptions.push(eventBus.subscribe('cvar.changed', (/** @type {string} */ cvarName) => {
      const cvar = Cvar.FindVar(cvarName);

      if (cvar && cvar.flags & Cvar.FLAG.SERVER) {
        this._UpdateServerInfo();
      }
    }));

    // Send initial update immediately
    this._UpdateServerInfo();
  }

  /**
   * Stop sending server info updates
   */
  _StopServerInfoSubscriptions() {
    while (this.serverEventSubscriptions.length > 0) {
      const unsubscribe = this.serverEventSubscriptions.pop();
      unsubscribe();
    }
  }

  /**
   * Gather and send current server info to master server
   */
  _UpdateServerInfo() {
    if (!this.isHost || !this.sessionId) {
      return;
    }

    // Gather server info from game state
    const serverInfo = this._GatherServerInfo();

    this._SendSignaling({
      type: 'update-server-info',
      serverInfo,
      isPublic: this._IsSessionPublic(),
    });
  }

  /**
   * Gather current server information from game state
   * Override this or hook into game state to provide actual values
   */
  _GatherServerInfo() {
    const serverInfo = {
      hostname: Cvar.FindVar('hostname').string,
      maxPlayers: SV.svs.maxclients,
      currentPlayers: NET.activeconnections,
      map: SV.server.mapname,
      mod: COM.game,
      /** @type {Record<string, string>} */
      settings: {},
    };

    for (const cvar of Cvar.Filter((/** @type {Cvar} */ cvar) => cvar.flags & Cvar.FLAG.SERVER)) {
      serverInfo.settings[cvar.name] = cvar.string;
    }

    return serverInfo;
  }

  /**
   * Determine if the session should be public
   * Can be controlled by a cvar or game setting
   * @returns {boolean} true if session is public
   */
  _IsSessionPublic() {
    // Check if there's a cvar controlling this
    return Cvar.FindVar('sv_public').value !== 0;
  }

  /**
   * Create a new session (host)
   * @param sock
   */
  _CreateSession(sock) {
    this._SendSignaling({ type: 'create-session' });
    sock.driverdata.isHost = true;
    this.isHost = true;
  }

  /**
   * Join an existing session
   * @param sock
   * @param sessionId
   */
  _JoinSession(sock, sessionId) {
    this._SendSignaling({
      type: 'join-session',
      sessionId: sessionId,
    });
    sock.driverdata.sessionId = sessionId;
    this.sessionId = sessionId;
  }

  /**
   * Handle messages from signaling server
   * @param message
   */
  _OnSignalingMessage(message) {
    switch (message.type) {
      case 'session-created':
        this._OnSessionCreated(message);
        break;

      case 'session-joined':
        this._OnSessionJoined(message);
        break;

      case 'peer-joined':
        this._OnPeerJoined(message);
        break;

      case 'peer-left':
        this._OnPeerLeft(message);
        break;

      case 'offer':
        this._OnOffer(message);
        break;

      case 'answer':
        this._OnAnswer(message);
        break;

      case 'ice-candidate':
        this._OnIceCandidate(message);
        break;

      case 'session-closed':
        this._OnSessionClosed(message);
        break;

      case 'pong':
        // Pong response from server - session is alive
        // Could track latency here if needed
        break;

      case 'error':
        Con.Print(`WebRTCDriver: Signaling error: ${message.error}\n`);
        this._OnSignalingError(message);
        break;

      default:
        Con.DPrint(`WebRTCDriver: Unknown signaling message: ${message.type}\n`);
    }
  }

  /**
   * Handle signaling errors (session not found, etc.)
   * @param message
   */
  _OnSignalingError(message) {
    // Find the socket that's trying to connect
    // Priority: look for sockets in CONNECTING state that match the error context
    let failedSocket = null;

    for (let i = 0; i < NET.activeSockets.length; i++) {
      const sock = NET.activeSockets[i];
      if (sock && sock.driver === this.driverlevel && sock.state === QSocket.STATE_CONNECTING) {
        // If the error mentions a session ID, try to match it
        if (sock.driverdata?.sessionId && message.error.includes(sock.driverdata.sessionId)) {
          failedSocket = sock;
          break;
        }
        // If we're creating a session and it fails
        if (sock.driverdata?.isHost && message.error.includes('already exists')) {
          failedSocket = sock;
          break;
        }
        // Otherwise, just mark the first connecting socket as failed
        if (!failedSocket) {
          failedSocket = sock;
        }
      }
    }

    if (failedSocket) {
      Con.PrintError(`WebRTCDriver: Connection failed - ${message.error}\n`);
      failedSocket.state = QSocket.STATE_DISCONNECTED;

      // Clean up the failed connection attempt if it was our current session
      if (failedSocket.driverdata?.sessionId === this.sessionId) {
        this.sessionId = null;
        this.peerId = null;
        this.isHost = false;
      }
    } else {
      // No matching socket found, just log the error
      Con.PrintWarning(`WebRTCDriver: Signaling error (no matching socket): ${message.error}\n`);
    }
  }

  /**
   * Session was created successfully
   * @param message
   */
  _OnSessionCreated(message) {
    this.sessionId = message.sessionId;
    this.peerId = message.peerId;
    this.isHost = message.isHost;
    this.creatingSession = false; // Session creation complete

    Con.Print(`WebRTCDriver: Session created: ${this.sessionId}\n`);
    Con.Print(`WebRTCDriver: Your peer ID: ${this.peerId}\n`);
    Con.Print(`WebRTCDriver: Share this session ID with others to join: ${this.sessionId}\n`);

    // Find the socket for this session and update it
    // For host sessions created via Listen(), we need to find any socket with isHost=true and null sessionId
    let sock = null;
    for (let i = 0; i < NET.activeSockets.length; i++) {
      const s = NET.activeSockets[i];
      if (s && s.driver === this.driverlevel && s.driverdata?.isHost && !s.driverdata?.sessionId) {
        sock = s;
        break;
      }
    }

    if (!sock) {
      // Fallback: try to find by sessionId
      sock = this._FindSocketBySession(this.sessionId);
    }

    if (sock && sock.driverdata) {
      sock.driverdata.sessionId = this.sessionId;
      sock.state = QSocket.STATE_CONNECTED;
      sock.address = `WebRTC Host (${this.sessionId})`;
      // Don't add host socket to newConnections - it's not an incoming client connection
      // Only peer connections should be added to newConnections when they join
      Con.Print('WebRTCDriver: Host socket ready for accepting peers\n');

      // Start sending periodic pings to keep session alive
      this._StartPingInterval();

      // Start sending periodic server info updates
      this._StartServerInfoSubscriptions();
    } else {
      Con.PrintWarning(`WebRTCDriver: No socket found for session ${this.sessionId}\n`);
    }
  }

  /**
   * Successfully joined a session
   * @param message
   */
  _OnSessionJoined(message) {
    this.sessionId = message.sessionId;
    this.peerId = message.peerId;
    this.isHost = message.isHost;

    Con.Print(`WebRTCDriver: Joined session: ${this.sessionId}\n`);
    Con.Print(`WebRTCDriver: Your peer ID: ${this.peerId}\n`);
    Con.Print(`WebRTCDriver: Peers in session: ${message.peerCount}\n`);

    // Find the socket for this session and mark it as connected
    const sock = this._FindSocketBySession(this.sessionId);
    if (sock) {
      // Don't mark as fully connected yet - wait for data channels to open
      // But update the address
      sock.address = `WebRTC Peer (${this.sessionId})`;
      Con.Print('WebRTCDriver: Socket found, waiting for P2P connection\n');
    } else {
      Con.PrintWarning(`WebRTCDriver: No socket found for joined session ${this.sessionId}\n`);
    }
  }

  /**
   * New peer joined the session
   * @param message
   */
  _OnPeerJoined(message) {
    Con.Print(`WebRTCDriver: Peer ${message.peerId} joined\n`);

    // If we're the host, create a new socket for this peer and initiate connection
    if (this.isHost) {
      // Create a QSocket for this peer connection
      const peerSock = NET.NewQSocket();
      peerSock.driver = this.driverlevel;
      peerSock.state = QSocket.STATE_CONNECTING;
      peerSock.address = `WebRTC Peer ${message.peerId}`;

      // Store peer-specific connection state
      peerSock.driverdata = {
        sessionId: this.sessionId,
        isHost: false,
        peerId: message.peerId, // This socket represents a connection to this specific peer
        peerConnections: new Map(),
        dataChannels: new Map(),
      };

      // Free up some QSocket structures
      peerSock.receiveMessage = [];
      peerSock.sendMessage = [];

      // Initiate P2P connection to this peer using the peer-specific socket
      this._CreatePeerConnection(peerSock, message.peerId, true);

      // Add to new connections so server accepts it as a client
      this.newConnections.push(peerSock);
      Con.Print(`WebRTCDriver: Created socket for peer ${message.peerId}, added to new connections\n`);
    }
  }

  /**
   * Peer left the session
   * @param message
   */
  _OnPeerLeft(message) {
    Con.Print(`WebRTCDriver: Peer ${message.peerId} left\n`);
    this._ClosePeerConnection(message.peerId);
  }

  /**
   * Received WebRTC offer from peer
   * @param message
   */
  async _OnOffer(message) {
    Con.DPrint(`WebRTCDriver: Received offer from ${message.fromPeerId}\n`);

    // Find our socket (we're the joining peer)
    const sock = this._FindSocketBySession(this.sessionId);
    if (!sock) {
      Con.PrintWarning('WebRTCDriver._OnOffer: No socket found for session\n');
      return;
    }

    const pc = this._CreatePeerConnection(sock, message.fromPeerId, false);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this._SendSignaling({
        type: 'answer',
        targetPeerId: message.fromPeerId,
        answer: pc.localDescription,
      });
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Error handling offer: ${error.message}\n`);
    }
  }

  /**
   * Received WebRTC answer from peer
   * @param message
   */
  async _OnAnswer(message) {
    Con.DPrint(`WebRTCDriver: Received answer from ${message.fromPeerId}\n`);

    // If we're the host, find the peer-specific socket
    // If we're a peer, find our own socket
    const sock = this.isHost ? this._FindSocketByPeerId(message.fromPeerId) : this._FindSocketBySession(this.sessionId);

    if (!sock || !sock.driverdata) {
      Con.PrintWarning(`WebRTCDriver._OnAnswer: No socket found for ${message.fromPeerId}\n`);
      return;
    }

    const pc = sock.driverdata.peerConnections.get(message.fromPeerId);
    if (!pc) {
      Con.PrintWarning(`WebRTCDriver: No peer connection found for ${message.fromPeerId}\n`);
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
      Con.DPrint(`WebRTCDriver: Answer processed for ${message.fromPeerId}\n`);
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Error handling answer: ${error.message}\n`);
    }
  }

  /**
   * Received ICE candidate from peer
   * @param message
   */
  async _OnIceCandidate(message) {
    // If we're the host, find the peer-specific socket
    // If we're a peer, find our own socket
    const sock = this.isHost
      ? this._FindSocketByPeerId(message.fromPeerId)
      : this._FindSocketBySession(this.sessionId);

    if (!sock || !sock.driverdata) {
      return;
    }

    const pc = sock.driverdata.peerConnections.get(message.fromPeerId);
    if (!pc) {
      return;
    }

    try {
      if (message.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      }
    } catch (error) {
      Con.DPrint(`WebRTCDriver: Error adding ICE candidate: ${error.message}\n`);
    }
  }

  /**
   * Session was closed
   * @param message
   */
  _OnSessionClosed(message) {
    Con.DPrint(`WebRTCDriver: Session closed: ${message.reason}\n`);

    const sock = this._FindSocketBySession(this.sessionId);
    if (sock) {
      sock.state = QSocket.STATE_DISCONNECTED;
    }

    this.sessionId = null;
    this.peerId = null;
    this.isHost = false;
  }

  /**
   * Create a peer connection
   * @param sock - The socket for this peer connection
   * @param peerId
   * @param initiator
   */
  _CreatePeerConnection(sock, peerId, initiator) {
    console.assert(sock && sock.driverdata, 'WebRTCDriver._CreatePeerConnection: Invalid socket');

    if (!sock || !sock.driverdata) {
      Con.PrintError('WebRTCDriver._CreatePeerConnection: No socket provided\n');
      return null;
    }

    // Check if connection already exists
    if (sock.driverdata.peerConnections.has(peerId)) {
      return sock.driverdata.peerConnections.get(peerId);
    }

    Con.DPrint(`WebRTCDriver: Creating peer connection to ${peerId} (initiator: ${initiator})\n`);

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    sock.driverdata.peerConnections.set(peerId, pc);

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        Con.DPrint(`WebRTCDriver: Sending ICE candidate to ${peerId}\n`);
        this._SendSignaling({
          type: 'ice-candidate',
          targetPeerId: peerId,
          candidate: event.candidate,
        });
      } else {
        Con.DPrint(`WebRTCDriver: ICE gathering complete for ${peerId}\n`);
      }
    };

    // Handle ICE connection state changes (more detailed than connectionState)
    pc.oniceconnectionstatechange = () => {
      Con.DPrint(`WebRTCDriver: ICE state with ${peerId}: ${pc.iceConnectionState}\n`);
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      Con.DPrint(`WebRTCDriver: Connection state with ${peerId}: ${pc.connectionState}\n`);

      if (pc.connectionState === 'connected') {
        Con.DPrint(`WebRTCDriver: P2P connection established with ${peerId}\n`);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        Con.DPrint(`WebRTCDriver: Connection ${pc.connectionState} with ${peerId}\n`);
        this._ClosePeerConnection(peerId);
      }
    };

    // Create data channels
    if (initiator) {
      // Reliable channel for important messages
      const reliableChannel = pc.createDataChannel('reliable', {
        ordered: true,
        maxRetransmits: 10,
      });

      // Unreliable channel for position updates, etc.
      const unreliableChannel = pc.createDataChannel('unreliable', {
        ordered: false,
        maxRetransmits: 0,
      });

      this._SetupDataChannel(sock, peerId, reliableChannel, unreliableChannel);

      // Create and send offer
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
        this._SendSignaling({
          type: 'offer',
          targetPeerId: peerId,
          offer: pc.localDescription,
        });
      }).catch((error) => {
        Con.PrintError(`WebRTCDriver: Error creating offer: ${error.message}\n`);
      });
    } else {
      // Wait for data channels from initiator
      pc.ondatachannel = (event) => {
        const channel = event.channel;

        if (!sock.driverdata.dataChannels.has(peerId)) {
          sock.driverdata.dataChannels.set(peerId, {});
        }

        const channels = sock.driverdata.dataChannels.get(peerId);

        if (channel.label === 'reliable') {
          channels.reliable = channel;
          this._SetupDataChannelHandlers(sock, peerId, channel);
        } else if (channel.label === 'unreliable') {
          channels.unreliable = channel;
          this._SetupDataChannelHandlers(sock, peerId, channel);
        }
      };
    }

    return pc;
  }

  /**
   * Setup data channels
   * @param sock
   * @param peerId
   * @param reliableChannel
   * @param unreliableChannel
   */
  _SetupDataChannel(sock, peerId, reliableChannel, unreliableChannel) {
    sock.driverdata.dataChannels.set(peerId, {
      reliable: reliableChannel,
      unreliable: unreliableChannel,
    });

    this._SetupDataChannelHandlers(sock, peerId, reliableChannel);
    this._SetupDataChannelHandlers(sock, peerId, unreliableChannel);
  }

  /**
   * Setup data channel event handlers
   * @param sock
   * @param peerId
   * @param channel
   */
  _SetupDataChannelHandlers(sock, peerId, channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      Con.DPrint(`WebRTCDriver: Data channel ${channel.label} opened with ${peerId}\n`);

      // Mark socket as connected when the reliable channel opens
      if (channel.label === 'reliable' && sock.state !== QSocket.STATE_CONNECTED) {
        sock.state = QSocket.STATE_CONNECTED;
        Con.DPrint('WebRTCDriver: Socket now CONNECTED (can send/receive data)\n');
      }
    };

    channel.onclose = () => {
      Con.DPrint(`WebRTCDriver: Data channel ${channel.label} closed with ${peerId}\n`);
    };

    channel.onerror = (error) => {
      Con.PrintError(`WebRTCDriver: Data channel error with ${peerId}: ${error}\n`);
    };

    channel.onmessage = (event) => {
      const data = new Uint8Array(event.data);
      sock.receiveMessage.push(data);
    };
  }

  /**
   * Close peer connection
   * @param peerId
   */
  _ClosePeerConnection(peerId) {
    // If we're the host, find the peer-specific socket
    // If we're a peer, find our own socket
    const sock = this.isHost ? this._FindSocketByPeerId(peerId) : this._FindSocketBySession(this.sessionId);

    if (!sock || !sock.driverdata) {
      Con.DPrint(`WebRTCDriver._ClosePeerConnection: No socket found for ${peerId}\n`);
      return;
    }

    const pc = sock.driverdata.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      sock.driverdata.peerConnections.delete(peerId);
    }

    sock.driverdata.dataChannels.delete(peerId);
  }

  /**
   * Find socket by session ID
   * @param sessionId
   */
  _FindSocketBySession(sessionId) {
    for (let i = 0; i < NET.activeSockets.length; i++) {
      const sock = NET.activeSockets[i];
      if (sock && sock.driver === this.driverlevel && sock.driverdata?.sessionId === sessionId) {
        return sock;
      }
    }
    return null;
  }

  /**
   * Find socket by peer ID (for host to find peer-specific sockets)
   * @param peerId
   */
  _FindSocketByPeerId(peerId) {
    for (let i = 0; i < NET.activeSockets.length; i++) {
      const sock = NET.activeSockets[i];
      if (sock && sock.driver === this.driverlevel && sock.driverdata?.peerId === peerId) {
        return sock;
      }
    }
    return null;
  }

  CheckNewConnections() {
    if (this.newConnections.length === 0) {
      return null;
    }

    const sock = this.newConnections.shift();
    Con.DPrint(`WebRTCDriver.CheckNewConnections: returning new connection ${sock.address}\n`);
    return sock;
  }

  GetMessage(qsocket) {
    // Check if we have collected new data
    if (qsocket.receiveMessage.length === 0) {
      if (qsocket.state === QSocket.STATE_DISCONNECTED) {
        return -1;
      }

      if (qsocket.state === QSocket.STATE_DISCONNECTING) {
        qsocket.state = QSocket.STATE_DISCONNECTED;
      }

      return 0;
    }

    // Fetch a message
    const message = qsocket.receiveMessage.shift();

    // Parse header
    const ret = message[0];
    const length = message[1] + (message[2] << 8);

    Con.DPrint(`WebRTCDriver.GetMessage: type=${ret}, length=${length}\n`);

    // Copy over the payload to our NET.message buffer
    new Uint8Array(NET.message.data).set(message.subarray(3, length + 3));
    NET.message.cursize = length;

    return ret;
  }

  SendMessage(qsocket, data) {
    const buffer = new Uint8Array(data.cursize + 3);
    buffer[0] = 1; // reliable message type
    buffer[1] = data.cursize & 0xff;
    buffer[2] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), 3);

    Con.DPrint(`WebRTCDriver.SendMessage: sending ${data.cursize} bytes (reliable)\n`);
    return this._SendToAllPeers(qsocket, buffer, true);
  }

  SendUnreliableMessage(qsocket, data) {
    const buffer = new Uint8Array(data.cursize + 3);
    buffer[0] = 2; // unreliable message type
    buffer[1] = data.cursize & 0xff;
    buffer[2] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), 3);

    Con.DPrint(`WebRTCDriver.SendUnreliableMessage: sending ${data.cursize} bytes (unreliable)\n`);
    return this._SendToAllPeers(qsocket, buffer, false);
  }

  /**
   * Send data to all connected peers
   * @param qsocket
   * @param buffer
   * @param reliable
   */
  _SendToAllPeers(qsocket, buffer, reliable) {
    console.assert(qsocket && qsocket.driverdata, 'WebRTCDriver._SendToAllPeers: Invalid socket');

    if (!qsocket.driverdata || !qsocket.driverdata.dataChannels) {
      Con.PrintError('WebRTCDriver._SendToAllPeers: no driverdata or channels\n');
      return -1;
    }

    let sentCount = 0;

    for (const [peerId, channels] of qsocket.driverdata.dataChannels) {
      const channel = reliable ? channels.reliable : channels.unreliable;

      if (!channel || channel.readyState !== 'open') {
        Con.DPrint(`WebRTCDriver._SendToAllPeers: channel to ${peerId} not open (state=${channel?.readyState})\n`);
        continue;
      }

      try {
        channel.send(buffer);
        Con.DPrint(`WebRTCDriver._SendToAllPeers: sent ${buffer.length} bytes to ${peerId} on ${channel.label}\n`);
        sentCount++;
      } catch (error) {
        Con.DPrint(`WebRTCDriver: Error sending to ${peerId}: ${error.message}\n`);
      }
    }

    if (sentCount === 0) {
      Con.DPrint('WebRTCDriver._SendToAllPeers: no peers available to send to\n');
    }

    return sentCount > 0 ? 1 : -1;
  }

  CanSendMessage(qsocket) {
    if (!qsocket.driverdata || !qsocket.driverdata.dataChannels) {
      return false;
    }

    // Can send if at least one reliable channel is open
    for (const channels of qsocket.driverdata.dataChannels.values()) {
      if (channels.reliable && channels.reliable.readyState === 'open') {
        return true;
      }
    }

    return false;
  }

  Close(qsocket) {
    if (!qsocket.driverdata) {
      qsocket.state = QSocket.STATE_DISCONNECTED;
      return;
    }

    // Close all peer connections
    if (qsocket.driverdata.peerConnections) {
      for (const pc of qsocket.driverdata.peerConnections.values()) {
        pc.close();
      }
      qsocket.driverdata.peerConnections.clear();
    }

    // Clear data channels
    if (qsocket.driverdata.dataChannels) {
      qsocket.driverdata.dataChannels.clear();
    }

    // Stop ping interval if this is the host socket
    if (qsocket.driverdata.isHost) {
      this._StopPingInterval();
      this._StopServerInfoSubscriptions();

      // Only the host leaving should trigger leave-session message
      // Peer-specific sockets closing should not leave the session
      if (this.sessionId) {
        this._SendSignaling({ type: 'leave-session' });
      }
    }

    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  /**
   * WebRTCDriver only listens in browser mode
   * Dedicated servers use WebSocketDriver instead
   * @returns {boolean} true if should listen
   */
  ShouldListen() {
    return !registry.isDedicatedServer;
  }

  Listen(listening) {
    // In browser environment, listening means hosting a WebRTC session
    if (!this.ShouldListen()) {
      // Dedicated servers don't use WebRTC
      return;
    }

    if (listening) {
      // Check if we already have a session or are creating one
      if (this.sessionId || this.creatingSession) {
        Con.DPrint('WebRTCDriver: Already hosting or creating a session\n');
        return;
      }

      // Auto-create a WebRTC host session for browser-based listen servers
      Con.DPrint('WebRTCDriver: Starting WebRTC host session for listen server\n');
      this.creatingSession = true;

      // Connect to signaling and create a host session
      if (!this._ConnectSignaling()) {
        Con.PrintWarning('WebRTCDriver: Failed to connect to signaling server\n');
        this.creatingSession = false;
        return;
      }

      // Create a QSocket for tracking this host session
      const sock = NET.NewQSocket();
      sock.driver = this.driverlevel;
      sock.state = QSocket.STATE_CONNECTING;
      sock.address = 'WebRTC Host';

      // Store connection state
      sock.driverdata = {
        sessionId: null, // Will be set when session is created
        isHost: true,
        peerConnections: new Map(),
        dataChannels: new Map(),
        signalingReady: false,
      };

      // Free up some QSocket structures
      sock.receiveMessage = [];
      sock.sendMessage = [];

      // Wait for signaling to be ready, then create session
      const createSessionWhenReady = () => {
        this._SendSignaling({
          type: 'create-session',
          serverInfo: this._GatherServerInfo(),
          isPublic: this._IsSessionPublic(),
        });
        Con.DPrint('WebRTCDriver: Session creation request sent\n');
      };

      if (this.signalingWs && this.signalingWs.readyState === 1) {
        // Already connected, send immediately
        createSessionWhenReady();
      } else {
        // Store callback for when signaling connects
        sock.driverdata.onSignalingReady = createSessionWhenReady;
      }

      this.isHost = true;

      Con.DPrint('WebRTCDriver: Waiting for signaling connection to create session...\n');
    } else {
      // Stop listening - tear down the session completely
      Con.DPrint('WebRTCDriver: Stopping listen server, tearing down session\n');

      // Stop ping interval
      this._StopPingInterval();
      this._StopServerInfoSubscriptions();

      // Close all sockets (host and peers)
      for (let i = NET.activeSockets.length - 1; i >= 0; i--) {
        const sock = NET.activeSockets[i];
        if (sock && sock.driver === this.driverlevel && sock.driverdata) {
          // Close all peer connections
          if (sock.driverdata.peerConnections) {
            for (const pc of sock.driverdata.peerConnections.values()) {
              pc.close();
            }
            sock.driverdata.peerConnections.clear();
          }

          // Clear data channels
          if (sock.driverdata.dataChannels) {
            sock.driverdata.dataChannels.clear();
          }

          // Mark socket as disconnected
          sock.state = QSocket.STATE_DISCONNECTED;
        }
      }

      // Leave session on signaling server
      if (this.sessionId) {
        this._SendSignaling({ type: 'leave-session' });
      }

      // Close signaling connection
      if (this.signalingWs) {
        this.signalingWs.close();
        this.signalingWs = null;
      }

      if (this.sessionId) {
        Con.Print('WebRTCDriver: Session torn down, no longer accepting connections\n');
      }

      // Reset state
      this.sessionId = null;
      this.peerId = null;
      this.isHost = false;
      this.creatingSession = false;
    }
  }
};

