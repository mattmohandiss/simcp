vim.lsp.enable({ "ts_ls", "nil_ls" })
require("conform").formatters_by_ft.typescript = { "prettier" }
require("conform").formatters_by_ft.python = { "ruff_format" }
require("lint").linters_by_ft.python = { "ruff" }
