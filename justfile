@default: help
@help:
	just --list

# installs package deps and readies the project
install:
	bun install

# detects linting issues
lint dir=".":
	bun x eslint {{dir}}

# detects linting issues and attempts to auto-resolve them
lint-fix dir=".":
	bun x eslint --fix {{dir}}

# detects formatting issues
format dir=".":
	bun x prettier --check {{dir}}

# detects formatting issues and attempts to auto-resolve them
format-fix dir=".":
	bun x prettier --write {{dir}}

# detects typing issues (tsc --noEmit)
typing:
	bun x tsc --noEmit

# runs tests
test target=".":
	bun test {{target}}

# runs tests with coverage
test-coverage target=".":
	bun test --coverage {{target}}

# builds standalone binary via bun --compile
build:
	bun build --compile ./index.ts --outfile pgmigrate

# runs the end-to-end test suite (requires docker + bun)
e2e: build
	cd e2e && bun run run.ts