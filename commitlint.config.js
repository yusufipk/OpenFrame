// commitlint.config.js
// Conventional Commits — https://www.conventionalcommits.org/en/v1.0.0/
//
// FORMAT:
//   <type>(<scope>): <description>
//
//   [optional body]
//
//   [optional footer(s)]
//
// EXAMPLES:
//   feat(auth): add OAuth2 login with GitHub
//   fix(video): resolve HLS buffering on mobile Safari
//   docs: update self-hosting guide in README
//   chore(deps): bump next from 16.1 to 16.2
//   refactor(api): extract pagination helper into lib/utils
//   perf(db): add index on Project.createdAt for dashboard query
//   ci: configure GitHub Actions matrix for Node 20 and 22
//   revert: revert "feat(billing): add yearly plan toggle"

/** @type {import('@commitlint/types').UserConfig} */
const config = {
  extends: ["@commitlint/config-conventional"],

  // ── Rules ──────────────────────────────────────────────────────────────────
  // Each rule is [severity, applicable, value]
  //   severity 0 = off, 1 = warn, 2 = error
  //   applicable 'always' | 'never'
  rules: {
    // ── Type ────────────────────────────────────────────────────────────────

    // Must be lowercase  (e.g. "feat" not "Feat")
    "type-case": [2, "always", "lower-case"],

    // Must not be empty
    "type-empty": [2, "never"],

    // Allowed commit types
    "type-enum": [
      2,
      "always",
      [
        "feat",      // ✨  New feature or user-facing capability
        "fix",       // 🐛  Bug fix
        "docs",      // 📝  Documentation only (README, comments, JSDoc)
        "style",     // 💄  Formatting, whitespace — no logic change
        "refactor",  // ♻️   Code restructure — no new feature, no bug fix
        "perf",      // ⚡️  Performance improvement
        "test",      // 🧪  Adding or correcting tests
        "build",     // 🏗️   Build system, bundler, or external dependencies
        "ci",        // 👷  CI/CD pipeline changes (GitHub Actions, Docker, etc.)
        "chore",     // 🔧  Maintenance tasks not fitting other types
        "revert",    // ⏪  Reverts a previous commit
        "security",  // 🔒  Security fix or hardening (not in base config)
        "i18n",      // 🌐  Internationalisation / translation (not in base)
        "dx",        // 🛠️   Developer experience (tooling, scripts, configs)
      ],
    ],

    // ── Scope ───────────────────────────────────────────────────────────────

    // Scope must be lowercase when provided  (e.g. "auth" not "Auth")
    "scope-case": [2, "always", "lower-case"],

    // Scope is optional — no rule enforced for "scope-empty"
    // Suggested scopes (not enforced):
    //   auth, api, db, video, billing, admin, ci, deps, ui, email,
    //   invitations, workspace, project, storage, notifications, onboarding

    // ── Subject (short description) ─────────────────────────────────────────

    // Must not be empty
    "subject-empty": [2, "never"],

    // Must NOT start with an uppercase letter
    // Good:  "add retry logic for upload"
    // Bad:   "Add retry logic for upload"
    "subject-case": [2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]],

    // Must NOT end with a period
    "subject-full-stop": [2, "never", "."],

    // Max 100 chars for the subject line (type + scope + description)
    "header-max-length": [2, "always", 100],

    // Min 10 chars to prevent meaningless one-word subjects
    "subject-min-length": [2, "always", 10],

    // ── Body ────────────────────────────────────────────────────────────────

    // Body lines should be wrapped at 120 chars
    "body-max-line-length": [2, "always", 120],

    // Blank line required between subject and body
    "body-leading-blank": [2, "always"],

    // ── Footer ──────────────────────────────────────────────────────────────

    // Blank line required between body and footer
    "footer-leading-blank": [1, "always"],

    // Footer lines should be wrapped at 120 chars
    "footer-max-line-length": [2, "always", 120],
  },

  // ── Prompt (interactive `bun run commit`) ──────────────────────────────────
  // Shown when using @commitlint/prompt-cli or czg
  prompt: {
    questions: {
      type: {
        description: "Select the type of change you are committing",
        enum: {
          feat:     { description: "A new feature",                            title: "Features",        emoji: "✨" },
          fix:      { description: "A bug fix",                                title: "Bug Fixes",       emoji: "🐛" },
          docs:     { description: "Documentation only changes",               title: "Documentation",   emoji: "📝" },
          style:    { description: "Formatting, missing semicolons, etc.",     title: "Styles",          emoji: "💄" },
          refactor: { description: "A code change without feature or fix",     title: "Refactors",       emoji: "♻️"  },
          perf:     { description: "A performance improvement",                title: "Performance",     emoji: "⚡️" },
          test:     { description: "Adding or correcting tests",               title: "Tests",           emoji: "🧪" },
          build:    { description: "Build system or dependency changes",       title: "Builds",          emoji: "🏗️" },
          ci:       { description: "CI/CD configuration changes",              title: "CI",              emoji: "👷" },
          chore:    { description: "Other changes (tooling, maintenance)",     title: "Chores",          emoji: "🔧" },
          revert:   { description: "Reverts a previous commit",               title: "Reverts",         emoji: "⏪" },
          security: { description: "A security fix or hardening",             title: "Security",        emoji: "🔒" },
          i18n:     { description: "Internationalisation / translation",       title: "i18n",            emoji: "🌐" },
          dx:       { description: "Developer experience improvements",        title: "DX",              emoji: "🛠️" },
        },
      },
    },
  },
};

export default config;
