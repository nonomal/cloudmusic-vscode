import type { ProviderCMsg, ProviderSMsg } from "@cloudmusic/shared";
import React, { useEffect, useState } from "react";
import type { NeteaseTypings } from "api";
import { Player } from "cloudmusic-wasm";
import { render } from "react-dom";
import { vscode } from "../utils";

const root = document.getElementById("root");

const toggle = () => vscode.postMessage({ command: "toggle" } as ProviderCMsg);
const previous = () =>
  vscode.postMessage({ command: "previous" } as ProviderCMsg);
const next = () => vscode.postMessage({ command: "next" } as ProviderCMsg);

function setMSAHandler() {
  if (!navigator.mediaSession) return;
  navigator.mediaSession.setActionHandler("play", toggle);
  navigator.mediaSession.setActionHandler("pause", toggle);
  navigator.mediaSession.setActionHandler("stop", toggle);

  navigator.mediaSession.setActionHandler("previoustrack", previous);
  navigator.mediaSession.setActionHandler("nexttrack", next);
}

function deleteMSAHandler() {
  if (!navigator.mediaSession) return;
  navigator.mediaSession.setActionHandler("play", null);
  navigator.mediaSession.setActionHandler("pause", null);
  navigator.mediaSession.setActionHandler("stop", null);
  navigator.mediaSession.setActionHandler("seekbackward", null);
  navigator.mediaSession.setActionHandler("seekforward", null);
  navigator.mediaSession.setActionHandler("seekto", null);
  navigator.mediaSession.setActionHandler("previoustrack", null);
  navigator.mediaSession.setActionHandler("nexttrack", null);
  /* navigator.mediaSession.setActionHandler("skipad", null);
  navigator.mediaSession.setActionHandler("togglemicrophone", null);
  navigator.mediaSession.setActionHandler("togglecamera", null);
  navigator.mediaSession.setActionHandler("hangup", null); */
}

deleteMSAHandler();

let master = false;
const player: Player = new Player();
let timerId: number | null = null;
let playing = false;
let d = 0;
let i = 0;

const dropTimer = () => {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
};

const pHandler = () => {
  if (player === null || !playing) return;
  if (player.empty()) {
    playing = false;
    vscode.postMessage({ command: "end" } as ProviderCMsg);
    return;
  }
  const pos = (Date.now() - i + d) / 1000;
  vscode.postMessage({ command: "position", pos } as ProviderCMsg);
};

// https://github.com/w3c/mediasession/issues/213
let audioEle: HTMLAudioElement | null = null;
let playable = "";

const testAudioSrc = async (files: string[]) => {
  const a = new Audio();
  for (const file of files) {
    a.src = file;
    try {
      await a.play();
      playable = file;
      break;
    } catch {}
  }
  a.pause();
};

const startSilent = () => {
  audioEle?.pause();
  if (!playable) return;
  audioEle = new Audio(playable);
  audioEle.loop = true;
  audioEle
    .play()
    // .then(() => audioEle?.pause())
    .catch(console.error);
};

const stopSilent = () => {
  audioEle?.pause();
  audioEle = null;
};

// eslint-disable-next-line @typescript-eslint/naming-convention
const Provider = (): JSX.Element => {
  const [profiles, setProfiles] = useState<NeteaseTypings.Profile[]>([]);

  useEffect(() => {
    const handler = ({ data }: { data: ProviderSMsg }) => {
      if (data.command === "master") {
        dropTimer();
        master = data.is;
        if (master) {
          setMSAHandler();
          timerId = setInterval(pHandler, 800);
          startSilent();
        } else {
          player.stop();
          deleteMSAHandler();
          stopSilent();
        }
        return;
      }
      if (!navigator.mediaSession) return;
      switch (data.command) {
        case "test":
          testAudioSrc(data.files)
            .then(() => master && startSilent())
            .catch(console.error);
          break;
        case "state":
          navigator.mediaSession.playbackState = data.state;
          break;
        /* case "position":
          navigator.mediaSession.setPositionState?.({
            position: data.position,
          });
          break; */
        case "metadata":
          navigator.mediaSession.metadata = new MediaMetadata(data);
          /* navigator.mediaSession.setPositionState?.({
            duration: data.duration,
          }); */
          break;
        case "account":
          setProfiles(data.profiles);
          break;
        case "load":
          fetch(data.url)
            .then((r) => r.arrayBuffer())
            .then((a) => {
              playing = !!player.load(new Uint8Array(a));
              i = Date.now();
              if (playing)
                vscode.postMessage({ command: "load" } as ProviderCMsg);
            })
            .catch((err) => {
              console.error(err);
              playing = false;
            });
          break;
        case "play":
          if (!playing) i = Date.now();
          playing = !!player.play();
          vscode.postMessage({ command: "playing", playing } as ProviderCMsg);
          break;
        case "pause":
          if (playing) d = Date.now() - i;
          player.pause();
          playing = false;
          break;
        case "stop":
          d = 0;
          player.stop();
          playing = false;
          break;
        case "volume":
          player.set_volume(data.level);
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [setProfiles]);

  return (
    <div className="flex flex-col max-w-2xl">
      <audio id="audio"></audio>
      {profiles.map(({ userId, nickname, avatarUrl, backgroundUrl }) => (
        <div
          key={userId}
          className="rounded-lg cursor-pointer mx-1 my-2 bg-center bg-cover"
          style={{ backgroundImage: `url("${backgroundUrl}")` }}
          onClick={() =>
            vscode.postMessage({ command: "account", userId } as ProviderCMsg)
          }
        >
          <div className="h-16 flex flex-row items-center overflow-hidden p-2 bg-black bg-opacity-30">
            <img
              className="rounded-full mx-4"
              src={avatarUrl}
              alt={nickname}
            ></img>
            <div className="text-white font-bold text-xl">{nickname}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

let loaded = false;

render(<Provider />, root, () => {
  if (loaded) return;
  loaded = true;
  vscode.postMessage({ command: "pageLoaded" } as ProviderCMsg);
});
