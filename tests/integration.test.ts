import { expect, it } from "vitest";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  service,
  fixture,
  barSelections,
  controls,
  waitForRun,
  temporary,
} from "./helpers.js";
import { Simulation } from "../src/service.js";
import { runProcess, type ProcessResult } from "../src/process.js";

it("completes STEP → explicit groups → native mesh → SIF → Elmer → analytic thermal results", async () => {
  let solverBehavior: "real" | "missing" | "no-output" | "failed" | "timeout" | "cancelled" = "real";
  const solverRunner = async (executable: string, args: string[], cwd: string, prefix: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> => {
    if (solverBehavior === "real") return runProcess(executable, args, cwd, prefix, timeoutMs, signal);
    await writeFile(join(cwd, `${prefix}.stdout`), "");
    await writeFile(join(cwd, `${prefix}.stderr`), "");
    const startedAt = new Date().toISOString();
    const result = (status: ProcessResult["status"], exitCode: number | null): ProcessResult => ({
      status, exitCode, signal: null, startedAt, endedAt: new Date().toISOString(), stdout: "", stderr: "",
    });
    if (solverBehavior === "missing") return result("spawn_error", null);
    if (solverBehavior === "no-output") return result("exited", 0);
    if (solverBehavior === "failed") return { ...result("exited", 9), stderr: "ERROR: forced failure" };
    if (solverBehavior === "timeout") return result("timeout", null);
    if (solverBehavior === "cancelled") {
      if (signal?.aborted) return result("cancelled", null);
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return result("cancelled", null);
    }
    throw new Error("Unexpected solver behavior");
  };
  const simulation = await service({}, { solverRunner });
  try {
    const inspected = await simulation.inspect({
      uri: pathToFileURL(fixture).href,
    });
    expect(inspected.inventory.sourceUnits).toBe("mm");
    expect(inspected.inventory.scaleToMeters).toBe(0.001);
    const volume = inspected.inventory.entities.find((e) => e.dimension === 3)!;
    expect(volume.measure).toBeCloseTo(0.00001, 10);
    expect(volume.bounds[3] - volume.bounds[0]).toBeCloseTo(0.1, 5);
    const selected = barSelections(inspected.inventory);
    const proposal = await simulation.propose(
      inspected.source,
      inspected.inspection,
      controls,
    );
    expect(proposal.inventory).toEqual(inspected.inventory);
    const meshed = await simulation.mesh(
      inspected.source,
      inspected.inspection,
      controls,
      selected.groups,
    );
    expect(meshed.metadata.groups.every((g) => g.elements > 0)).toBe(true);
    expect(meshed.metadata.groups.map((g) => g.id)).toEqual(
      selected.groups.map((g) => g.id),
    );
    expect(meshed.metadata.elementCount).toBeGreaterThan(0);
    expect(meshed.metadata.minimumQuality).toBeGreaterThan(0);
    expect(
      Object.values(meshed.metadata.files).every(
        (f) => f.format === "elmer-mesh" && !f.uri?.endsWith("/mesh"),
      ),
    ).toBe(true);
    const configured = await simulation.configure(meshed.mesh, selected.config);
    const started = await simulation.start(configured.case);
    const run = await waitForRun(simulation, started.runId);
    const evidence =
      run.status === "succeeded"
        ? []
        : await Promise.all(
            [
              ...run.logs,
              ...run.outputs.filter((output) => output.format === "text"),
            ].map(
              async (ref) =>
                `${ref.uri?.split("/").at(-1)}:\n${(await simulation.artifacts.verify(ref)).toString("utf8")}`,
            ),
          );
    expect(run.status, `${JSON.stringify(run)}\n${evidence.join("\n")}`).toBe(
      "succeeded",
    );
    expect(run.solver.version).toMatch(/Elmer|version/i);
    const scalar = (name: string) =>
      run.summaries.find((s) => s.name === name)!.value;
    expect(Math.abs(scalar("temperature_min") - 300)).toBeLessThan(0.1);
    expect(Math.abs(scalar("temperature_max") - 400)).toBeLessThan(0.1);
    expect(
      Math.abs(scalar("heat_flux_magnitude_mean") - 10000) / 10000,
    ).toBeLessThan(0.01);
    // Independent benchmark geometry gives A=1e-4 m²; this derivation is
    // benchmark-only, never advertised as a generic integrated heat flow.
    expect(
      Math.abs(scalar("heat_flux_magnitude_mean") * 0.0001 - 1),
    ).toBeLessThan(0.01);
    const vtu = (
      await simulation.artifacts.verify(run.results[0].artifact)
    ).toString();
    const positions = vtu
      .match(/<Points>\s*<DataArray[^>]*>([\s\S]*?)<\/DataArray>/)![1]
      .trim()
      .split(/\s+/)
      .map(Number);
    const temperatures = vtu
      .match(
        /<DataArray[^>]*Name="temperature"[^>]*>([\s\S]*?)<\/DataArray>/i,
      )![1]
      .trim()
      .split(/\s+/)
      .map(Number);
    expect(positions.length).toBe(3 * temperatures.length);
    temperatures.forEach((t, i) =>
      expect(Math.abs(t - (400 - 1000 * positions[3 * i]))).toBeLessThan(0.1),
    );
    const restarted = await Simulation.create(simulation.settings);
    expect((await restarted.status(run.runId)).status).toBe("succeeded");

    solverBehavior = "missing";
    const missing = await waitForRun(
      simulation,
      (await simulation.start(configured.case)).runId,
    );
    expect(missing.status).toBe("failed");
    expect(missing.error?.code).toBe("spawn_error");
    expect(missing.logs).toHaveLength(2);
    expect((await simulation.status(run.runId)).status).toBe("succeeded");

    solverBehavior = "no-output";
    const noOutput = await waitForRun(
      simulation,
      (await simulation.start(configured.case)).runId,
    );
    expect(noOutput.status).toBe("failed");
    expect(noOutput.error?.code).toBe("malformed_results");
    solverBehavior = "failed";
    const solverError = await waitForRun(
      simulation,
      (await simulation.start(configured.case)).runId,
    );
    expect(solverError.execution?.exitCode).toBe(9);
    expect(solverError.status).toBe("failed");
    solverBehavior = "timeout";
    simulation.settings.timeoutMs = 50;
    const timedOut = await waitForRun(
      simulation,
      (await simulation.start(configured.case)).runId,
    );
    expect(timedOut.status).toBe("timeout");
    simulation.settings.timeoutMs = 120000;
    solverBehavior = "cancelled";
    const cancelled = await simulation.start(configured.case);
    expect((await simulation.cancel(cancelled.runId)).status).toBe("cancelled");

    // Exact-byte result revision verification applies after server restarts.
    const resultPath = fileURLToPath(run.results[0].artifact.uri!);
    await chmod(resultPath, 0o600);
    await writeFile(resultPath, (await readFile(resultPath, "utf8")) + "\n");
    await expect(restarted.status(run.runId)).rejects.toMatchObject({
      code: "stale_artifact",
    });
  } finally {
    await simulation.close();
  }
}, 240000);

it("rejects malformed STEP without invoking another service", async () => {
  const root = await temporary();
  await writeFile(join(root, "bad.step"), "not STEP");
  const simulation = await service({ roots: [root] });
  try {
    await expect(
      simulation.inspect({ uri: pathToFileURL(join(root, "bad.step")).href }),
    ).rejects.toMatchObject({ code: "unsupported_format" });
    await writeFile(join(root, "bad.step"), "ISO-10303-21;\nmalformed\n");
    await expect(
      simulation.inspect({ uri: pathToFileURL(join(root, "bad.step")).href }),
    ).rejects.toMatchObject({ code: "process_failed" });
  } finally {
    await simulation.close();
  }
}, 30000);
