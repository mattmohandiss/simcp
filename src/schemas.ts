import { readFileSync } from "node:fs";
import { z } from "zod";

export const artifactContract = JSON.parse(
  readFileSync(
    new URL("../contracts/artifact-ref.schema.json", import.meta.url),
    "utf8",
  ),
);
// The local schema omits $id so nested ArtifactRefs do not collide in SDK output schemas.
export type ArtifactRef = {
  revision: string;
  uri?: string;
  format: string;
  units?: string;
};
export const artifactSchema = z.fromJSONSchema(
  artifactContract,
) as z.ZodType<ArtifactRef>;
export const id = z.string().uuid();
export const controlsSchema = z
  .strictObject({
    minSize: z.number().positive().max(1000),
    maxSize: z.number().positive().max(1000),
    units: z.literal("m"),
  })
  .refine((x) => x.minSize <= x.maxSize, "minSize must not exceed maxSize");
export const groupSchema = z.strictObject({
  id: z.number().int().min(1).max(999),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/),
  dimension: z.union([z.literal(2), z.literal(3)]),
  entities: z.array(z.number().int().positive()).min(1),
});
export type Group = z.infer<typeof groupSchema>;
export const quantity = <T extends string>(units: T, positive = false) =>
  z.strictObject({
    value: positive ? z.number().positive() : z.number(),
    units: z.literal(units),
  });
export const thermalSchema = z.strictObject({
  physics: z.literal("steady-heat-conduction"),
  materials: z
    .array(
      z.strictObject({
        group: z.number().int().positive(),
        conductivity: quantity("W/(m.K)", true),
      }),
    )
    .min(1),
  sources: z
    .array(
      z.strictObject({
        group: z.number().int().positive(),
        heat: quantity("W/m3"),
      }),
    )
    .default([]),
  boundaries: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal("temperature"),
          temperature: z.strictObject({
            value: z.number().nonnegative(),
            units: z.literal("K"),
          }),
        }),
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal("flux"),
          inwardFlux: quantity("W/m2"),
        }),
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal("insulated"),
        }),
      ]),
    )
    .min(1),
});
export type Thermal = z.infer<typeof thermalSchema>;
const triple = z.tuple([z.number(), z.number(), z.number()]);
export const inventorySchema = z.strictObject({
  protocol: z.literal(1),
  gmshVersion: z.string(),
  sourceUnits: z.enum(["m", "mm", "cm", "um"]),
  scaleToMeters: z.number().positive(),
  idScheme: z.literal("gmsh-occ-import-v1"),
  frame: z.strictObject({
    id: z.literal("step-world-si"),
    units: z.literal("m"),
    origin: triple,
    axes: z.tuple([triple, triple, triple]),
    handedness: z.literal("right"),
  }),
  entities: z.array(
    z.strictObject({
      dimension: z.union([z.literal(2), z.literal(3)]),
      tag: z.number().int().positive(),
      label: z.string(),
      bounds: z.tuple([
        z.number(),
        z.number(),
        z.number(),
        z.number(),
        z.number(),
        z.number(),
      ]),
      center: triple,
      measure: z.number().positive(),
      measureUnits: z.enum(["m2", "m3"]),
      adjacentVolumes: z.array(z.number().int()),
    }),
  ),
  diagnostics: z.array(z.string()),
});
export type Inventory = z.infer<typeof inventorySchema>;
export const workerMeshSchema = z.strictObject({
  protocol: z.literal(1),
  inventory: inventorySchema,
  groups: z.array(
    groupSchema.extend({ elements: z.number().int().positive() }),
  ),
  nodeCount: z.number().int().positive(),
  elementCount: z.number().int().positive(),
  minimumQuality: z.number().positive(),
});
export const meshSchema = z.strictObject({
  kind: z.literal("simulation-mesh-v1"),
  source: artifactSchema,
  inventory: artifactSchema,
  controls: controlsSchema,
  groups: z.array(
    groupSchema.extend({ elements: z.number().int().positive() }),
  ),
  gmsh: artifactSchema,
  files: z.strictObject({
    "mesh.header": artifactSchema,
    "mesh.nodes": artifactSchema,
    "mesh.elements": artifactSchema,
    "mesh.boundary": artifactSchema,
  }),
  gmshVersion: z.string(),
  elmerGridVersion: z.string(),
  minimumQuality: z.number().positive(),
  nodeCount: z.number().int().positive(),
  elementCount: z.number().int().positive(),
  connectedBodies: z.array(z.array(z.number().int().positive())),
  boundaryBodies: z.record(z.string(), z.array(z.number().int().positive())),
  diagnostics: z.array(z.string()),
  logs: z.array(artifactSchema),
});
export type Mesh = z.infer<typeof meshSchema>;
export const caseSchema = z.strictObject({
  kind: z.literal("simulation-case-v1"),
  mesh: artifactSchema,
  config: thermalSchema,
  sif: artifactSchema,
});
export type Case = z.infer<typeof caseSchema>;
