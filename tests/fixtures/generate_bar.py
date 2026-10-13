"""MIT-licensed, deterministic 100 x 10 x 10 mm OCC STEP bar fixture generator.

Requires the Gmsh Python API. Geometry is a single axis-aligned solid with a
declared millimeter length unit; all six faces are physically selected in tests.
"""
from pathlib import Path

import gmsh

path = Path(__file__).with_name("bar.step")
gmsh.initialize()
try:
    gmsh.model.add("analytic_conduction_bar")
    gmsh.model.occ.addBox(0, 0, 0, 100, 10, 10)
    gmsh.model.occ.synchronize()
    gmsh.write(str(path))
finally:
    gmsh.finalize()

# Gmsh's STEP writer omits unit metadata, so declare the coordinates' unit.
text = path.read_text()
path.write_text(text.replace("DATA;", "DATA;\n#999999=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));", 1))
