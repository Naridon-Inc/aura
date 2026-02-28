# Configuration

> Configure Entire settings for your project and preferences

Entire uses a layered configuration system that allows project-wide settings to be shared via Git while supporting personal overrides.

1. **Local settings**: `.entire/settings.local.json`
2. **Project settings**: `.entire/settings.json`
3. **Global settings**: `~/.config/entire/settings.json`

## Settings Reference
- `enabled`: boolean
- `log_level`: string
- `telemetry`: boolean
- `strategy_options`: object
