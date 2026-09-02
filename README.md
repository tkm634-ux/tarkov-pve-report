# Tarkov PvE Report

This repository stores the latest Escape from Tarkov PvE hideout profitability report generated from the Cloudflare report gateway.

## Data flow

Tarkov.dev PvE -> Cloudflare Worker -> Cloudflare Pages -> GitHub Actions -> this repository -> ChatGPT GitHub connector

## Files

- `data/report.txt` — compact human-readable hideout ranking
- `data/report.json` — structured ranking result
- `data/integrity.json` — source-reference integrity check
- `.github/workflows/update-report.yml` — refresh job

The workflow refreshes the report every 15 minutes and can also be run manually from GitHub Actions.
