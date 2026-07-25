/**
 * Detach the test process from any ambient git repository.
 *
 * Git resolves its target repository from the environment before it looks at
 * the working directory. When the suite runs inside a git hook — husky's
 * pre-commit runs `npm test` — git exports `GIT_DIR` and friends to the hook,
 * and every `git` a test spawns for a fixture repo under /tmp inherits them.
 * The fixture then operates on *this* repository instead of its own `cwd`:
 * its `git commit` re-enters this repo's pre-commit hook in a directory with
 * no package.json (so the commit fails), and its staging can drop real entries
 * out of this repo's index. That is not hypothetical — it silently untracked
 * `deploy/pm2/ecosystem.config.cjs`, which `.gitignore` then refused to
 * re-add.
 *
 * Eight test files spawn git, so this belongs here rather than in each one.
 */
const AMBIENT_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_CONFIG_PARAMETERS",
] as const;

for (const key of AMBIENT_GIT_VARS) {
  delete process.env[key];
}
