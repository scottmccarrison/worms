const canvas = document.getElementById("game");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("#game canvas missing");
}

const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("2D canvas context unavailable");
}

ctx.fillStyle = "#e0e0e0";
ctx.font = "24px system-ui, sans-serif";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("scaffolding ready", canvas.width / 2, canvas.height / 2);

ctx.font = "14px system-ui, sans-serif";
ctx.fillStyle = "#888";
ctx.fillText(`vite dev - ${new Date().toISOString()}`, canvas.width / 2, canvas.height / 2 + 32);
