'use strict';
// Single source of truth for where Nyxia's local-inference (Ollama) lives.
// Desktop-only today; the NAS migration (see project_nyxia_nas_migration)
// repoints this one value instead of hunting scattered 127.0.0.1:11434
// literals across the codebase.
const OLLAMA_HOST = process.env.NYXIA_OLLAMA_HOST || '127.0.0.1:11434';
const OLLAMA_URL = `http://${OLLAMA_HOST}`;
const OLLAMA_V1_URL = `${OLLAMA_URL}/v1`;

module.exports = { OLLAMA_HOST, OLLAMA_URL, OLLAMA_V1_URL };
