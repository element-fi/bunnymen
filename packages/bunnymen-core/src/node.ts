import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import type { PeerIdStr } from '@chainsafe/libp2p-gossipsub/dist/src/types'
import { noise } from '@chainsafe/libp2p-noise'
import { bootstrap } from '@libp2p/bootstrap'
import { kadDHT } from '@libp2p/kad-dht'
import { mdns } from '@libp2p/mdns'
import { mplex } from '@libp2p/mplex'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { tcp } from '@libp2p/tcp'
import { webRTCStar } from '@libp2p/webrtc-star'
import { webSockets } from '@libp2p/websockets'
import { EventEmitter } from 'events'
import * as IPFS from 'ipfs-core'
import { createLibp2p, Libp2pOptions } from 'libp2p'
import { nanoid } from 'nanoid'
import os from 'os'
import path from 'path'
import { Channel } from './channel.js'

const isBrowser = typeof window !== 'undefined'

export interface INodeEvents {
  subscribed: (property: string) => void
  unsubscribed: (property: string) => void
  peerSubscribed: (property: string) => void
  peerUnsubscribed: (property: string) => void
  selectedLeader: (property: string) => void
  sentMessage: (property: string) => void
  receivedMessage: (property: string) => void
  uploadedData: (property: string) => void
  downloadedData: (property: string) => void
}

export class Node extends EventEmitter {
  private BASE_TOPIC = '_peer-discovery._p2p._pubsub'
  private _ipfs: IPFS.IPFS | undefined
  private _libp2p: Libp2pOptions | IPFS.Libp2pFactoryFn | undefined
  private _opts: any
  private _topicToChannel: Map<string, Channel> = new Map<string, Channel>()
  private _peerId: PeerIdStr = ''
  private _untypedOn = this.on
  private _untypedEmit = this.emit

  public override on = <K extends keyof INodeEvents>(
    event: K,
    listener: INodeEvents[K],
  ): this => this._untypedOn(event, listener)

  public override emit = <K extends keyof INodeEvents>(
    event: K,
    ...args: Parameters<INodeEvents[K]>
  ): boolean => this._untypedEmit(event, ...args)

  get peerId(): string {
    return this._peerId
  }

  getPeers(topic: string): string[] {
    return this.getChannnel(topic).peers
  }

  isLeader(topic: string): boolean {
    return this.getChannnel(topic).isLeader()
  }

  constructor() {
    super()
  }

  async start() {
    const libp2p = (opts: any) => {
      this._opts = opts
      this._peerId = opts.peerId.toString()
      return this.configureLibp2p()
    }

    this._ipfs = await IPFS.create({
      repo: path.join(os.tmpdir(), `repo-${nanoid()}`),
      libp2p: libp2p,
    })

    this._libp2p = await libp2p
  }

  async subscribe(topic: string, frequency: number = 100): Promise<void> {
    const channel: Channel = new Channel(this._libp2p, this._ipfs, topic)
    channel.subscribe()
    this.registerEvents(channel)
    channel.poll(frequency)
    this._topicToChannel.set(topic, channel)
    this.emit('subscribed', topic)
  }

  async unsubscribe(topic: string) {
    this._topicToChannel.delete(topic)
    this.emit('unsubscribed', topic)
  }

  async sendMessage(topic: string, message: string): Promise<string> {
    return this.getChannnel(topic).sendMessage(message)
  }

  async upload(topic: string, data: string): Promise<string> {
    return this.getChannnel(topic).upload(data)
  }

  async download(topic: string, cid: string): Promise<string> {
    return this.getChannnel(topic).download(cid)
  }

  private getChannnel(topic: string) {
    const channel = this._topicToChannel.get(topic)
    if (channel) {
      return channel
    }
    throw new Error("Topic doesn't exist!")
  }

  private registerEvents(channel: Channel) {
    channel.on('peerSubscribed', (data: any) =>
      this.emit('peerSubscribed', data),
    )
    channel.on('peerUnsubscribed', (data) =>
      this.emit('peerUnsubscribed', data),
    )
    channel.on('selectedLeader', (data) => this.emit('selectedLeader', data))
    channel.on('sentMessage', (data) => this.emit('sentMessage', data))
    channel.on('receivedMessage', (data) => this.emit('receivedMessage', data))
  }

  // see https://github.com/libp2p/js-libp2p/blob/master/doc/CONFIGURATION.md
  private configureLibp2p() {
    const transports = [webSockets()]
    const boostraplist = [
      '/dns4/bootstrap.libp2p.io/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
      '/dns4/bootstrap.libp2p.io/wss/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
      '/dns4/bootstrap.libp2p.io/wss/p2p/QmZa1sAxajnQjVM8WjWXoMbmPd7NsWhfKsPkErzpm9wGkp',
      '/dns4/bootstrap.libp2p.io/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
      '/dns4/bootstrap.libp2p.io/wss/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
    ]

    const peerDiscovery: any = [
      bootstrap({
        list: boostraplist,
        timeout: 10000, // in ms,
        tagName: 'bootstrap',
        tagValue: 50,
        tagTTL: Infinity, // browser's need a constant connection to bootstrap nodes
      }),

      pubsubPeerDiscovery({
        interval: 5000,
        topics: [this.BASE_TOPIC],
        listenOnly: false, // enabling listenOnly to eliminate an issue where it tries to intercept bunnymen messages and decode them
      }),
    ]
    if (isBrowser) {
      const wRTCStar = webRTCStar()
      transports.push(wRTCStar.transport)
      peerDiscovery.push(wRTCStar.discovery)
    } else {
      peerDiscovery.push(
        mdns({
          broadcast: true,
          port: 50002,
          compat: true,
        }),
      )
      transports.push(tcp())
    }
    return createLibp2p({
      peerId: this._opts.peerId,
      addresses: {
        // Add the signaling server address, along with our PeerId to our multiaddrs list
        // libp2p will automatically attempt to dial to the signaling server so that it can
        // receive inbound connections from other peers
        listen: [
          '/ip4/127.0.0.1/tcp/0/wss',
          '/ip4/127.0.0.1/tcp/0',
          '/ip4/0.0.0.0/tcp/0/wss',
          '/ip4/0.0.0.0/tcp/0',
          '/ip4/127.0.0.1/tcp/13579/ws/p2p-webrtc-star/', // local webrtc-star server
        ],
      },
      connectionManager: {
        pollInterval: 5000,
        autoDial: true, // auto dial to peers we find when we have less peers than `connectionManager.minConnections`,
        minConnections: 20,
      },
      transports,
      connectionEncryption: [noise()],
      streamMuxers: [mplex()],
      dht: kadDHT(),
      peerDiscovery,
      relay: {
        enabled: true, // Allows you to dial and accept relayed connections. Does not make you a relay.
        hop: {
          enabled: true,
          active: false, // Allows you to be a relay for other peers
        },
      },
      pubsub: gossipsub({
        enabled: true,
        emitSelf: false,
        allowPublishToZeroPeers: true,
        floodPublish: false,
      }),
    })
  }
}
