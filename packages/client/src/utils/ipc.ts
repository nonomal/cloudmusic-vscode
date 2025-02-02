import {
  CONF,
  FOREIGN,
  HTTPS_API,
  MUSIC_CACHE_SIZE,
  MUSIC_QUALITY,
  ipcBroadcastServerPath,
  ipcServerPath,
} from "../constant";
import type {
  CSConnPool,
  IPCBroadcastMsg,
  IPCClientMsg,
  IPCServerMsg,
} from "@cloudmusic/shared";
import { LocalFileTreeItem, QueueProvider } from "../treeview";
import type {
  NeteaseAPICMsg,
  NeteaseAPIKey,
  NeteaseAPIParameters,
  NeteaseAPIReturn,
} from "@cloudmusic/server";
import type { PlayTreeItemData } from "../treeview";
import type { Socket } from "net";
import { State } from ".";
import { connect } from "net";
import { ipcDelimiter } from "@cloudmusic/shared";

class IPCClient<T, U = T> {
  private _buffer = "";

  private _socket?: Socket;

  constructor(private readonly _path: string) {}

  connect(handler: (data: U) => void, retry: number): Promise<boolean> {
    if (this._socket?.readable && this._socket.writable)
      return Promise.resolve(true);
    else this.disconnect();
    return new Promise(
      (resolve) =>
        void this._tryConnect(retry)
          .then((socket) => {
            if (!socket) throw new Error();

            this._socket = socket
              .on("data", (data) => {
                const buffer = this._buffer + data.toString();

                const msgs = buffer.split(ipcDelimiter);
                this._buffer = msgs.pop() ?? "";
                for (const msg of msgs) handler(JSON.parse(msg) as U);
              })
              .on("close", () => this.disconnect())
              .on("error", console.error);

            resolve(true);
          })
          .catch(() => resolve(false))
    );
  }

  disconnect(): void {
    this._socket?.destroy();
    this._socket = undefined;
  }

  send(data: T): void {
    this._socket?.write(`${JSON.stringify(data)}${ipcDelimiter}`);
  }

  request<D>(data: D): void {
    this._socket?.write(`${JSON.stringify(data)}${ipcDelimiter}`);
  }

  private _tryConnect(retry: number): Promise<Socket | undefined> {
    return new Promise((resolve) => {
      const setTimer = (remain: number) => {
        const socket = connect({ path: this._path }).setEncoding("utf8");
        const listener = () => {
          socket.destroy();
          if (remain > 0) setTimeout(() => setTimer(remain - 1), 512);
          else resolve(undefined);
        };
        socket
          .on("error", ({ message }) => console.error(message))
          .once("connect", () => {
            setTimeout(() => resolve(socket), 512);
            socket.off("close", listener);
          })
          .once("close", listener);
      };
      if (retry <= 0) setTimer(0);
      else setTimeout(() => setTimer(retry), 512);
    });
  }
}

const ipc = new IPCClient<IPCClientMsg, IPCServerMsg>(ipcServerPath);
const ipcB = new IPCClient<IPCBroadcastMsg>(ipcBroadcastServerPath);

export class IPC {
  static requestPool = new Map() as CSConnPool;

  static async connect(
    ipcHandler: Parameters<typeof ipc.connect>[0],
    ipcBHandler: Parameters<typeof ipcB.connect>[0],
    retry = 4
  ): Promise<[boolean, boolean]> {
    return await Promise.all([
      ipc.connect(ipcHandler, retry),
      ipcB.connect(ipcBHandler, retry),
    ]);
  }

  static disconnect(): void {
    ipc.disconnect();
    ipcB.disconnect();
  }

  static load(): void {
    const { playItem } = State;
    if (!playItem) return;
    ipcB.send({ t: "player.load" });

    if (playItem instanceof LocalFileTreeItem) {
      ipc.send({
        t: "player.load",
        url: playItem.tooltip,
        local: true,
      });
    } else {
      const {
        data: { pid },
        item: { dt, id },
      } = playItem;
      const next = State.fm ? undefined : QueueProvider.next?.item.id;
      ipc.send({ t: "player.load", dt, id, pid, next });
    }
  }

  static loaded(): void {
    ipcB.send({ t: "player.loaded" });
  }

  static deleteCache(key: string): void {
    ipc.send({ t: "control.deleteCache", key });
  }

  static download(url: string, path: string): void {
    ipc.send({ t: "control.download", url, path });
  }

  static init(
    volume?: number,
    player?: { wasm: boolean; name?: string }
  ): void {
    const conf = CONF();
    ipc.send({
      t: "control.init",
      volume,
      player,
      mq: MUSIC_QUALITY(conf),
      cs: MUSIC_CACHE_SIZE(conf),
      https: HTTPS_API(conf),
      foreign: FOREIGN(conf),
    });
  }

  static lyric(): void {
    ipc.send({ t: "control.lyric" });
  }

  static music(): void {
    ipc.send({ t: "control.music" });
  }

  static neteaseAc(): void {
    ipc.send({ t: "control.netease" });
  }

  static retain(items?: readonly PlayTreeItemData[]): void {
    ipc.send({ t: "control.retain", items });
  }

  static lyricDelay(delay: number): void {
    ipc.send({ t: "player.lyricDelay", delay });
  }

  static playing(playing: boolean): void {
    ipc.send({ t: "player.playing", playing });
  }

  static position(pos: number): void {
    ipc.send({ t: "player.position", pos });
  }

  static repeat(r: boolean): void {
    ipcB.send({ t: "player.repeat", r });
  }

  static stop(): void {
    ipc.send({ t: "player.stop" });
  }

  static toggle(): void {
    ipc.send({ t: "player.toggle" });
  }

  static volume(level: number): void {
    ipc.send({ t: "player.volume", level });
  }

  static add(items: readonly PlayTreeItemData[], index?: number): void {
    ipcB.send({ t: "queue.add", items, index });
  }

  static clear(): void {
    ipcB.send({ t: "queue.clear" });
  }

  static delete(id: number | string): void {
    ipcB.send({ t: "queue.delete", id });
  }

  static fm(uid: number, is = true): void {
    ipc.send({ t: "queue.fm", uid, is });
  }

  static fmNext(): void {
    ipc.send({ t: "queue.fmNext" });
  }

  static new(items: readonly PlayTreeItemData[], id?: number): void {
    ipcB.send({ t: "queue.new", items, id });
  }

  static playSong(id: number | string): void {
    ipcB.send({ t: "queue.play", id });
  }

  static random(): void {
    ipcB.send({
      t: "queue.new",
      items: QueueProvider.random(),
    });
  }

  static shift(index: number): void {
    ipcB.send({ t: "queue.shift", index });
  }

  static netease<I extends NeteaseAPIKey>(
    i: I,
    p: NeteaseAPIParameters<I>
  ): Promise<NeteaseAPIReturn<I>> {
    const channel = `netease-${i}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      const prev = this.requestPool.get(channel);
      prev?.reject();
      this.requestPool.set(channel, { resolve, reject });
      ipc.request<NeteaseAPICMsg<I>>({
        t: "api.netease",
        channel,
        msg: { i, p },
      });
    });
  }
}
