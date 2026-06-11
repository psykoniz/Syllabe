#!/usr/bin/env bun
import { Command } from "commander";
import { runCommand } from "./commands/run";
import { resumeCommand } from "./commands/resume";
import { reportCommand } from "./commands/report";
import { buildCommand } from "./commands/build";

const program = new Command("projectos")
  .version("0.0.1")
  .description("ProjectOS — personal project-building OS powered by Claude");

program.addCommand(runCommand);
program.addCommand(resumeCommand);
program.addCommand(reportCommand);
program.addCommand(buildCommand);

program.parse(process.argv);
