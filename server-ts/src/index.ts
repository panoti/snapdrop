import { IncomingMessage } from 'node:http';
import * as process from 'process';
import * as parser from 'ua-parser-js';
import { uniqueNamesGenerator, animals, colors } from 'unique-names-generator';
import * as WebSocket from 'ws';


// Handle SIGINT
process.on('SIGINT', () => {
  console.info("SIGINT Received, exiting...");
  process.exit(0);
});

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.info("SIGTERM Received, exiting...");
  process.exit(0);
});

declare global {
  interface String {
    hashCode(): string;
  }
}

type IncomingMessageEx = IncomingMessage & { peerId?: string; }

interface PeerName {
  model: string;
  os: string;
  browser: string;
  type: string;
  deviceName: string;
  displayName: string;
}

interface PeerInfo {
  id: string;
  name: PeerName;
  rtcSupported: boolean;
}

type ServerMsg = {
  type: 'display-name';
  message: {
    displayName: string;
    deviceName: string;
  };
} | {
  type: 'peer-joined';
  peer: PeerInfo;
} | {
  type: 'peers';
  peers: Peer[];
} | {
  type: 'peer-left';
  peerId: string;
} | {
  type: 'ping';
} | {
  type: 'disconnect';
} | {
  type: 'pong';
};

type ClientMsg = {
  type: 'pong' | 'disconnect' | 'signal';
  to: string;
  sender: string;
};

class SnapdropServer {
  private _wss: WebSocket.Server;
  private _rooms: { [id: string]: { [id: string]: Peer; }; };

  constructor(port: number) {
    this._wss = new WebSocket.Server({ port: port });
    this._wss.on('connection', (socket, request) => this._onConnection(new Peer(socket, request)));
    this._wss.on('headers', (headers, response) => this._onHeaders(headers, response));
    this._rooms = {};

    console.log('Snapdrop is running on port', port);
  }

  private _onConnection(peer: Peer) {
    this._joinRoom(peer);
    peer.socket.on('message', (message: string) => this._onMessage(peer, message));
    peer.socket.on('error', console.error);
    this._keepAlive(peer);

    // send displayName
    this._send(peer, {
      type: 'display-name',
      message: {
        displayName: peer.name.displayName,
        deviceName: peer.name.deviceName
      }
    });
  }

  private _onHeaders(headers: string[], response: IncomingMessageEx) {
    if (response.headers.cookie && response.headers.cookie.indexOf('peerid=') > -1) return;
    response.peerId = Peer.uuid();
    headers.push('Set-Cookie: peerid=' + response.peerId + "; SameSite=Strict; Secure");
  }

  private _onMessage(sender: Peer, msg: string) {
    let message: ClientMsg;

    // Try to parse message 
    try {
      message = JSON.parse(msg);
    } catch (e) {
      return; // TODO: handle malformed JSON
    }

    switch (message.type) {
      case 'disconnect':
        this._leaveRoom(sender);
        break;
      case 'pong':
        sender.lastBeat = Date.now();
        break;
    }

    // relay message to recipient
    if (message.to && this._rooms[sender.ip]) {
      const recipientId = message.to; // TODO: sanitize
      const recipient = this._rooms[sender.ip][recipientId];
      delete message.to;
      // add sender id
      message.sender = sender.id;
      this._send(recipient, message as any);
      return;
    }
  }

  private _joinRoom(peer: Peer) {
    // if room doesn't exist, create it
    if (!this._rooms[peer.ip]) {
      this._rooms[peer.ip] = {};
    }

    // notify all other peers
    for (const otherPeerId in this._rooms[peer.ip]) {
      const otherPeer = this._rooms[peer.ip][otherPeerId];
      this._send(otherPeer, {
        type: 'peer-joined',
        peer: peer.getInfo()
      });
    }

    // notify peer about the other peers
    const otherPeers = [];
    for (const otherPeerId in this._rooms[peer.ip]) {
      otherPeers.push(this._rooms[peer.ip][otherPeerId].getInfo());
    }

    this._send(peer, {
      type: 'peers',
      peers: otherPeers
    });

    // add peer to room
    this._rooms[peer.ip][peer.id] = peer;
  }

  private _leaveRoom(peer: Peer) {
    if (!this._rooms[peer.ip] || !this._rooms[peer.ip][peer.id]) return;
    this._cancelKeepAlive(this._rooms[peer.ip][peer.id]);

    // delete the peer
    delete this._rooms[peer.ip][peer.id];

    peer.socket.terminate();
    //if room is empty, delete the room
    if (!Object.keys(this._rooms[peer.ip]).length) {
      delete this._rooms[peer.ip];
    } else {
      // notify all other peers
      for (const otherPeerId in this._rooms[peer.ip]) {
        const otherPeer = this._rooms[peer.ip][otherPeerId];
        this._send(otherPeer, { type: 'peer-left', peerId: peer.id });
      }
    }
  }

  private _send(peer: Peer, message: ServerMsg) {
    if (!peer) return;
    if (this._wss['readyState'] !== WebSocket.OPEN) return;
    const msg = JSON.stringify(message);
    peer.socket.send(msg, error => '');
  }

  private _keepAlive(peer: Peer) {
    this._cancelKeepAlive(peer);
    const timeout = 30000;
    if (!peer.lastBeat) {
      peer.lastBeat = Date.now();
    }
    if (Date.now() - peer.lastBeat > 2 * timeout) {
      this._leaveRoom(peer);
      return;
    }

    this._send(peer, { type: 'ping' });

    peer.timerId = setTimeout(() => this._keepAlive(peer), timeout);
  }

  private _cancelKeepAlive(peer: Peer) {
    if (peer && peer.timerId) {
      clearTimeout(peer.timerId);
    }
  }
}

class Peer {
  public socket: WebSocket.WebSocket;
  public rtcSupported: boolean;
  public timerId: NodeJS.Timeout;
  public lastBeat: number;
  public id: string;
  public ip: string;
  public name: PeerName;

  constructor(socket: WebSocket.WebSocket, request: IncomingMessageEx) {
    // set socket
    this.socket = socket;
    // set remote ip
    this._setIP(request);
    // set peer id
    this._setPeerId(request)
    // is WebRTC supported ?
    this.rtcSupported = request.url.indexOf('webrtc') > -1;
    // set name 
    this._setName(request);
    // for keepalive
    this.timerId = undefined;
    this.lastBeat = Date.now();
  }

  private _setIP(request: IncomingMessageEx) {
    if (request.headers['x-forwarded-for']) {
      this.ip = (request.headers['x-forwarded-for'] as string).split(/\s*,\s*/)[0];
    } else {
      this.ip = request.connection.remoteAddress;
    }
    // IPv4 and IPv6 use different values to refer to localhost
    if (this.ip == '::1' || this.ip == '::ffff:127.0.0.1') {
      this.ip = '127.0.0.1';
    }
  }

  private _setPeerId(request: IncomingMessageEx) {
    if (request.peerId) {
      this.id = request.peerId;
    } else {
      this.id = request.headers.cookie.replace('peerid=', '');
    }
  }

  public toString() {
    return `<Peer id=${this.id} ip=${this.ip} rtcSupported=${this.rtcSupported}>`
  }

  private _setName(req: IncomingMessageEx) {
    let ua = parser(req.headers['user-agent']);


    let deviceName = '';

    if (ua.os && ua.os.name) {
      deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
    }

    if (ua.device.model) {
      deviceName += ua.device.model;
    } else {
      deviceName += ua.browser.name;
    }

    if (!deviceName)
      deviceName = 'Unknown Device';

    const displayName = uniqueNamesGenerator({
      length: 2,
      separator: ' ',
      dictionaries: [colors, animals],
      style: 'capital',
      seed: this.id.hashCode(),
    });

    this.name = {
      model: ua.device.model,
      os: ua.os.name,
      browser: ua.browser.name,
      type: ua.device.type,
      deviceName,
      displayName
    };
  }

  public getInfo(): PeerInfo {
    return {
      id: this.id,
      name: this.name,
      rtcSupported: this.rtcSupported
    };
  }

  // return uuid of form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  static uuid() {
    let uuid = '';
    let ii: number;

    for (ii = 0; ii < 32; ii += 1) {
      switch (ii) {
        case 8:
        case 20:
          uuid += '-';
          uuid += (Math.random() * 16 | 0).toString(16);
          break;
        case 12:
          uuid += '-';
          uuid += '4';
          break;
        case 16:
          uuid += '-';
          uuid += (Math.random() * 4 | 8).toString(16);
          break;
        default:
          uuid += (Math.random() * 16 | 0).toString(16);
      }
    }
    return uuid;
  };
}

Object.defineProperty(String.prototype, 'hashCode', {
  value: function () {
    let hash = 0;
    let i: number;
    let chr: number;

    for (i = 0; i < this.length; i++) {
      chr = this.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
  }
});

const server = new SnapdropServer(parseInt(process.env.PORT) || 3000);
