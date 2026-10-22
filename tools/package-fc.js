const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const packageRoot = path.join(dist, "fc-package");
const zipPath = path.join(dist, "word-practice-generator-fc.zip");

fs.rmSync(packageRoot, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(path.join(packageRoot, "data"), { recursive: true });
fs.copyFileSync(path.join(root, "server.js"), path.join(packageRoot, "server.js"));
fs.copyFileSync(path.join(root, "data", "word-bank.json"), path.join(packageRoot, "data", "word-bank.json"));
fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
  name: "word-practice-generator-api",
  private: true,
  scripts: { "start:fc": "HOST=0.0.0.0 PORT=9000 HOSTED_MODE=1 node server.js" }
}, null, 2) + "\n");

const result = spawnSync("/usr/bin/zip", ["-rq", zipPath, "."], {
  cwd: packageRoot,
  stdio: "inherit"
});
if (result.status !== 0) throw new Error("无法生成 FC 部署包");
console.log(`FC 部署包：${zipPath}`);
