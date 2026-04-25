import * as Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";
import { LobbyScene } from "./scenes/LobbyScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: "game-container",
  backgroundColor: "#0b0b0f",
  scene: [BootScene, LobbyScene, GameScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  dom: {
    createContainer: true,
  },
};

const game = new Phaser.Game(config);

// iOS Safari/PWA report new innerWidth/innerHeight asynchronously after
// the rotation event. Refresh Phaser's scale twice to catch both windows.
// iOS 16.4+ uses screen.orientation.change; older Safari still fires
// window.orientationchange. Listen to both - refresh is idempotent.
const refreshScale = () => {
  setTimeout(() => game.scale.refresh(), 100);
  setTimeout(() => game.scale.refresh(), 500);
};
window.addEventListener("orientationchange", refreshScale);
if (
  typeof screen !== "undefined" &&
  screen.orientation &&
  typeof screen.orientation.addEventListener === "function"
) {
  screen.orientation.addEventListener("change", refreshScale);
}
