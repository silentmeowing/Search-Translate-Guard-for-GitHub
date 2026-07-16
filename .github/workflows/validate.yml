name: Validate extension

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Install development dependencies
        run: npm ci
      - name: Install Chromium
        run: npx playwright install --with-deps chromium
      - name: Validate generated files, manifest, and installable package
        run: npm run build:check && npm run validate && npm run package:check
      - name: Run browser regression tests
        run: npm test
      - name: Build installable extension package
        run: npm run package
      - name: Upload installable extension package
        uses: actions/upload-artifact@v4
        with:
          name: search-translate-guard-extension
          path: dist/Search-Translate-Guard-for-GitHub-extension-v*.zip
          if-no-files-found: error
