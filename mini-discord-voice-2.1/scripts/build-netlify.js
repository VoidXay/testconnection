const fs = require("fs");
const path = require("path");

const outputPath = path.join(__dirname, "..", "public", "runtime-config.js");
const socketServerUrl = String(process.env.SOCKET_SERVER_URL || "")
    .trim()
    .replace(/\/$/, "");

const contents = `window.MINI_DISCORD_CONFIG = ${JSON.stringify(
    { socketServerUrl },
    null,
    4
)};\n`;

fs.writeFileSync(outputPath, contents, "utf8");

if (socketServerUrl) {
    console.log(`Netlify frontend configured for ${socketServerUrl}`);
} else {
    console.warn(
        "SOCKET_SERVER_URL is empty. Set it in Netlify environment variables to your Render URL."
    );
}
