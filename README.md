# Simulation MCP

Independent local stdio MCP: STEP → explicit physical groups → Gmsh → ElmerGrid
→ typed steady conduction → ElmerSolver → revisioned VTU/scalars/logs.
Node 24 / TypeScript uses MCP SDK 2.3.1. A Python Gmsh
worker uses a one-request/one-response JSON-file protocol (`protocol: 1`).
No other MCP service, cloud service or prepared SIF is required.

**Local validation (2026-10-13):** Nix Gmsh 4.15.0 and Elmer 26.2 completed the
analytic thermal benchmark. Unit, artifact, process, and thermal integration tests
passed locally. This is local runtime evidence, not verification of every target platform.

## Install and launch

The repository owns its artifact schema in `contracts/`. Builds bundle that
schema and the Python worker; Gmsh and Elmer runtimes are installed separately.

From this directory:

```sh
nix develop
just setup
just build
export SIMULATION_INPUT_ROOTS='["/absolute/path/to/models"]'
export SIMULATION_WORKSPACE=/absolute/path/to/run-workspace
just start
```

`.envrc` already contains `use flake`; `direnv allow` is an alternative to
`nix develop`. `.env.example` documents variables; `.env` is not auto-loaded.
`just setup` installs npm dependencies without lifecycle scripts. The flake
pins nixpkgs (and thus Gmsh) by commit, and pins upstream Elmer by commit.
Elmer's transitive inputs use its checked-in lock.

Nix provisions the solver toolchain only on x86_64-linux and aarch64-linux.
`packages.<system>.toolchain` provisions Node, Gmsh, the Python wrapper and
headless upstream Elmer built serially without MPI, OpenMP, ElmerIce or Lua. The analytic
thermal benchmark passes with that serial solver. The dev shell also provisions
Python, Ruff and Nix tooling;
TypeScript language server/formatter/linter/test deps are project-local npm
dependencies. Gmsh's Python module lives under its Nix package's `lib`, supplied
through `PYTHONPATH`. Elmer is an external package, not compiled by npm.

Non-Nix deployments must provide compatible Gmsh Python bindings and native
library plus `ElmerGrid` and `ElmerSolver` with `HeatSolve`, `FluxSolver`,
`SaveData` and `ResultOutputSolve` modules. Executables are operator configuration:

| Variable                 | Default / meaning                                    |
| ------------------------ | ---------------------------------------------------- |
| `SIMULATION_INPUT_ROOTS` | Required JSON array of existing absolute input roots |
| `SIMULATION_WORKSPACE`   | `.simulation-runs`; local run/artifact storage      |
| `SIMULATION_PYTHON`      | `python3` (Windows: `python`); Nix sets its wrapper  |
| `SIMULATION_ELMERGRID`   | `ElmerGrid`                                          |
| `SIMULATION_ELMERSOLVER` | `ElmerSolver`                                        |
| `SIMULATION_TIMEOUT_MS`  | 120000 per worker/conversion/solve; maximum 3600000  |

Generic host configuration example (environment may instead be inherited from
the Nix shell):

```json
{
  "command": "node",
  "args": ["/absolute/path/to/simulation/dist/src/index.js"],
  "env": {
    "SIMULATION_INPUT_ROOTS": "[\"/absolute/path/to/models\"]",
    "SIMULATION_WORKSPACE": "/absolute/path/to/run-workspace",
    "SIMULATION_PYTHON": "/absolute/path/to/provisioned/simulation-python",
    "SIMULATION_ELMERGRID": "/absolute/path/to/ElmerGrid",
    "SIMULATION_ELMERSOLVER": "/absolute/path/to/ElmerSolver"
  }
}
```

## Staged tools

1. `inspect_source({uri})` or `inspect_source({source: ArtifactRef})` reads
   exact STEP bytes. It returns `source`, revisioned `inspection`, inventory and
   logs. Supported STEP SI length units are m/mm/cm/µm; mixed, missing or
   unsupported length units fail explicitly. Gmsh OCC targets meters and retains
   world placement. Entity bounds/centers have frame `step-world-si`; measures
   have m²/m³ units. Imported body count is not a semantic assembly tree.
2. `propose_mesh({source, inspection, controls})` rechecks refs and returns
   candidates. Controls are `{minSize:0.003,maxSize:0.006,units:"m"}`.
3. `generate_mesh({source, inspection, controls, groups})` requires explicit
   groups of `{id,name,dimension,entities}`. IDs 1–999 and simple ASCII names
   must be unique across dimensions. Every surface/solid must be assigned once;
   each volume group contains exactly one solid. No auto-selecting regions.
   Linear tetrahedra use ASCII MSH 2.2, then `ElmerGrid 14 2 mesh.msh -out mesh`.
   Counts, positive minSICN quality and native connectivity/group membership are
   checked. Return `mesh` is a ref to **Simulation-owned JSON metadata**, with
   separate exact-byte Gmsh and four constituent Elmer mesh file refs. No
   directory is hashed or presented as a byte-stream artifact.
4. `configure_thermal_case({mesh, config})` validates full material coverage,
   all surface BCs, disconnected-component constraints and conflicting nodal
   temperatures; writes normalized JSON and deterministic SIF. Example:

   ```json
   {
     "physics": "steady-heat-conduction",
     "materials": [
       { "group": 1, "conductivity": { "value": 10, "units": "W/(m.K)" } }
     ],
     "sources": [],
     "boundaries": [
       {
         "group": 2,
         "kind": "temperature",
         "temperature": { "value": 400, "units": "K" }
       },
       {
         "group": 3,
         "kind": "temperature",
         "temperature": { "value": 300, "units": "K" }
       },
       { "group": 4, "kind": "insulated" }
     ]
   }
   ```

   Group IDs above are illustrative; use the returned mapping. Optional source
   assignment: `{group:1,heat:{value:100,units:"W/m3"}}`; optional flux BC:
   `{group:4,kind:"flux",inwardFlux:{value:50,units:"W/m2"}}`.
   Positive flux enters the solid. Missing heat sources mean zero; insulation
   must be selected explicitly. Materials are constant positive isotropic
   conductivities. No arbitrary SIF, expressions, procedures or scripts.

5. `run_analysis({case})` returns immediately with `runId`; all constituent
   revisions and generated SIF are verified before execution. Each solve gets
   a unique directory. `inspect_run({runId})` reports preparing/running/succeeded/
   failed/timeout/cancelled/interrupted. `cancel_run({runId})` terminates only an
   active process group owned by this instance and retains evidence.
6. Successful run metadata links source, mesh metadata, config, generated SIF,
   solver banner/version, execution timing/status, logs and output refs. VTU
   fields are inventoried; SaveScalars returns nodal temperature min/max/mean
   and mean projected flux magnitude, each with units, method and source ref.
   Means are **not** volume averages or integrated heat rates. Success requires
   exit 0, no explicit failure diagnostics, positive temperature nonlinear
   convergence flag and valid finite outputs. Numerical tolerances and raw
   outputs remain available for independent interpretation.

Tool failures use MCP `isError` with JSON domain error code/message and, where
available, revisioned diagnostic log refs. Failed solves return inspectable run
metadata rather than disguising partial outputs as successful results.

## Boundaries, security and retention

- This is a trusted-local tool, not a filesystem sandbox. Input roots are
  canonicalized and used to catch accidental path mistakes; the server assumes
  the local user and files are trusted. Do not expose it to untrusted clients.
- Artifact revisions are SHA-256 digests of the exact bytes read or produced.
  Reusing a ref after its file changes fails explicitly, but concurrent edits
  during an operation are not defended against.
- Processes use configured executables and argument arrays, no shell. The local
  process environment is inherited for runtime compatibility, with deterministic
  locale/thread settings applied; child tools therefore also inherit local env vars.
- Per-process wall timeout, serial execution and 8 MiB combined captured-output
  bound are enforced. There is no portable memory, mesh-size, input-size or
  workspace-disk quota; provision OS quotas/cgroups if deployment needs them.
- V1 supports separate solid regions and exterior BC groups. Internal/orphan
  native boundaries fail; no contact resistance, automatic fragmentation,
  repairs, nonconformal coupling, radiation, transient or nonlinear physics.
- Selectors are tied to exact source revision, Gmsh version and
  `gmsh-occ-import-v1`. No Geometry SubjectRef-to-Gmsh topology equivalence is
  claimed. Imported names are hints, never engineering intent.
- No automatic deletion. Shut down the server, then explicitly archive/remove
  UUID operation directories when refs are no longer needed. `just clean`
  removes only compiled code. Interrupted records are not resumed. After an
  ungraceful termination inspect/reap any orphaned solver processes before
  restarting against that workspace. Graceful shutdown cancels owned runs.
- Hosted deployments need an external isolation boundary (e.g. a container or VM
  with explicit input mounts and resource limits); application path checks are
  not a substitute. These outputs are numerical evidence, not engineering certification.

## Implementation choices

- The Gmsh Python API owns STEP import, topology inventory, and mesh generation.
  It communicates with TypeScript through a bounded JSON-file worker protocol;
  no generated `.geo` script is required.
- Typed inputs generate deterministic SIF. PyElmer and model-authored SIF are
  unnecessary for the supported steady thermal workflow.
- ASCII MSH 2.2 transfers explicit physical groups to ElmerGrid; converted group
  membership and connectivity are verified instead of trusting labels alone.
- Upstream Elmer and Gmsh are external tools provisioned by Nix, not downloaded
  by npm at server startup. Non-Nix deployments can configure executable paths.
- Scalar summaries and VTU inventory are intentionally limited to the supported
  solver output. Geometry IDs are not cross-kernel mesh selectors.

## Artifact references

Every reference identifies one exact byte stream with `revision: "sha256:<64
lowercase hex digits>"` and a `format`. A URI is an optional locator; operations
requiring bytes need an accessible local `file:` URI. Supported format identifiers
are `step`, `gmsh-msh`, `elmer-mesh`, `vtu`, `elmer-sif`, `text`, and `json`.
Derived artifacts receive their own digests. An Elmer mesh directory is not a
single artifact: its metadata references individual native files.

## Server checks

The lightweight `checks` shell includes Node and Ruff without building the
Gmsh/Elmer solver toolchain:

```sh
# Run from this repository.
nix develop .#checks --accept-flake-config --command just setup
nix develop .#checks --accept-flake-config --command just check
nix develop --accept-flake-config --command just integration
nix develop --accept-flake-config --command just check
nix develop --accept-flake-config --command just build
```

`just integration` runs the opt-in direct-service Gmsh/Elmer benchmark. It is
server-owned integration coverage; public stdio acceptance runs separately
against the built server artifact.

In a source checkout, `tests/fixtures/README.md` documents analytic bar dimensions,
generation, and temperature/heat-flux tolerances. Unit checks do not require a
solver runtime. Native integration checks additionally cover malformed inputs,
solver failures, timeout/cancellation, restart persistence, and stale outputs.
Tests use the operating system's temporary directory;
`SIMULATION_TEST_TMP` can select another temporary root.

Licensing and upstream source references are recorded in
[third-party notices](THIRD_PARTY_NOTICES.md).

## Package preparation

`npm pack` builds first and includes compiled runtime code, the local artifact
schema, Python worker, README, and third-party notices. Tests, source maps, and
Python caches are excluded. Install the tarball to check `simulation-mcp-server`
with a compatible MCP client. The server requires protocol `2026-07-28` and
rejects legacy negotiation. Native tools still require separate installation.

A project license must be selected and added before public release; third-party
notices do not license this server's own code.
