#!/usr/bin/env bun
import { Command } from "commander";
import { runCommand } from "./commands/run";
import { resumeCommand } from "./commands/resume";
import { reportCommand } from "./commands/report";
import { buildCommand } from "./commands/build";
import { evalCommand } from "./commands/eval";
import { selfImproveCommand } from "./commands/self-improve";
import { replayCommand } from "./commands/replay";
import { webCommand } from "./commands/web";

const program = new Command("projectos")
  .version("0.0.1")
  .description("ProjectOS — personal project-building OS powered by Claude");

program.addCommand(runCommand);
program.addCommand(resumeCommand);
program.addCommand(reportCommand);
program.addCommand(buildCommand);
program.addCommand(evalCommand);
program.addCommand(selfImproveCommand);
program.addCommand(replayCommand);
program.addCommand(webCommand);

program.parse(process.argv);
