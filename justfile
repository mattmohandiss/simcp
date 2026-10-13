default:
    just --list

# Dependency installation is explicit; npm scripts do not run solvers.
setup:
    npm install --ignore-scripts

dev:
    npm run dev

build:
    npm run build

start:
    npm start

typecheck:
    npm run typecheck

lint:
    npm run lint
    ruff check worker

fmt:
    npm run fmt
    ruff format worker
    nixpkgs-fmt flake.nix

test:
    npm test

integration:
    npm run test:integration

fixture:
    python3 tests/fixtures/generate_bar.py

check: typecheck lint test

# Removing run evidence is deliberately not part of clean/build/setup.
clean:
    node scripts/clean-dist.mjs
