// CopilotKit's runtime reports usage to telemetry.copilotkit.ai unless this is
// set, and it reads the variable once when its module loads. OpenDots does not
// use CopilotKit's hosted services, so it opts out by default. This module must
// be imported before anything that imports `@copilotkit/runtime`. An explicit
// value in the environment is respected.
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= 'true';
