"use strict";

const initEngine = require("stockfish");

process.on("disconnect", () => process.exit(0));

initEngine("lite-single").then((engine) => {
  engine.listener = (line) => process.send(line);
  process.on("message", (command) => engine.sendCommand(String(command)));
  process.send("hostready");
});
