import { IPC, MultiStepInput, State, likeMusic } from "../utils";
import { QueueItemTreeItem, QueueProvider } from "../treeview";
import { ButtonManager } from "../manager";
import type { ExtensionContext } from "vscode";
import { VOLUME_KEY } from "../constant";
import { commands } from "vscode";
import i18n from "../i18n";

export function initCommand(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand("cloudmusic.previous", () => {
      if (!State.fm && QueueProvider.len) IPC.shift(-1);
    }),

    commands.registerCommand("cloudmusic.next", () => {
      if (State.fm) IPC.fmNext();
      else if (QueueProvider.len) IPC.shift(1);
    }),

    commands.registerCommand("cloudmusic.toggle", () => IPC.toggle()),

    commands.registerCommand("cloudmusic.repeat", () =>
      IPC.repeat(!State.repeat)
    ),

    commands.registerCommand("cloudmusic.like", () => {
      if (State.like && State.playItem instanceof QueueItemTreeItem) {
        const id = State.playItem.valueOf;
        void MultiStepInput.run((input) => likeMusic(input, 1, id));
      }
    }),

    commands.registerCommand(
      "cloudmusic.volume",
      () =>
        void MultiStepInput.run(async (input) => {
          const levelS = await input.showInputBox({
            title: i18n.word.volume,
            step: 1,
            totalSteps: 1,
            value: `${context.globalState.get(VOLUME_KEY, 85)}`,
            prompt: `${i18n.sentence.hint.volume} (0~100)`,
          });
          if (/^[1-9]\d$|^\d$|^100$/.exec(levelS)) {
            const level = parseInt(levelS);
            IPC.volume(level);
            await context.globalState.update(VOLUME_KEY, level);
          }
          return input.stay();
        })
    ),

    commands.registerCommand("cloudmusic.toggleButton", () =>
      ButtonManager.toggle()
    )
  );
}
