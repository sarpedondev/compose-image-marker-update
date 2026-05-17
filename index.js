const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

function input(name, required = false) {
  const candidates = [
    `INPUT_${name.replace(/ /g, "_").toUpperCase()}`,
    `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`,
  ];

  let value = "";

  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      value = process.env[key] || "";
      break;
    }
  }

  if (required && !value.trim()) {
    fail(`Missing required input: ${name}`);
  }

  return value;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
  } else {
    console.log(`::set-output name=${name}::${value}`);
  }
}

function mask(value) {
  if (value) {
    console.log(`::add-mask::${value}`);
  }
}

function run(command, args, options = {}) {
  const result = cp.spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    const stdout = result.stdout ? result.stdout.trim() : "";
    const stderr = result.stderr ? result.stderr.trim() : "";

    if (options.allowFailure) {
      return result;
    }

    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }

  return result;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern) {
  let out = "^";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === "*") {
      const next = pattern[i + 1];

      if (next === "*") {
        const after = pattern[i + 2];

        if (after === "/") {
          out += "(?:.*\\/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }

  out += "$";
  return new RegExp(out);
}

function walkFiles(root) {
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  walk(root);
  return files;
}

function splitPatterns(raw) {
  return raw
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function updateFiles({ repoDir, filesInput, marker, image }) {
  const patterns = splitPatterns(filesInput);
  const regexes = patterns.map(globToRegex);

  const allFiles = walkFiles(repoDir);
  const matchedFiles = allFiles.filter((file) => {
    const rel = path.relative(repoDir, file).replaceAll(path.sep, "/");
    return regexes.some((regex) => regex.test(rel));
  });

  const changedFiles = [];
  let markerFound = false;

  for (const file of matchedFiles) {
    const original = fs.readFileSync(file, "utf8");
    const lines = original.split(/(?<=\n)/);

    let changed = false;

    const updated = lines.map((line) => {
      if (!line.includes(marker) || !line.includes("image:")) {
        return line;
      }

      markerFound = true;

      const indentMatch = line.match(/^\s*/);
      const indent = indentMatch ? indentMatch[0] : "";

      const hasNewline = line.endsWith("\n");
      const newline = hasNewline ? "\n" : "";

      const trimmed = line.trim();
      const afterImage = trimmed.split("image:", 2)[1]?.trim() || "";

      let quote = "";
      if (afterImage.startsWith('"')) {
        quote = '"';
      } else if (afterImage.startsWith("'")) {
        quote = "'";
      }

      const nextLine = quote
        ? `${indent}image: ${quote}${image}${quote} ${marker}${newline}`
        : `${indent}image: ${image} ${marker}${newline}`;

      if (nextLine !== line) {
        changed = true;
      }

      return nextLine;
    });

    if (changed) {
      fs.writeFileSync(file, updated.join(""), "utf8");
      changedFiles.push(path.relative(repoDir, file).replaceAll(path.sep, "/"));
    }
  }

  return { markerFound, changedFiles };
}

function main() {
  const repoInput = input("repo", false).trim();
  const repo = repoInput || process.env.GITHUB_REPOSITORY || "";
  const branch = input("branch", false).trim() || "main";
  const token = input("token", true).trim();
  const image = input("image", true).trim();
  const markerName = input("marker", true).trim();
  const filesInput = input("files", false) || "**/*.yml\n**/*.yaml";
  const markerPrefix = input("marker-prefix", false).trim() || "image-tag";
  const commitMessageInput = input("commit-message", false).trim();
  const gitUserName =
    input("git-user-name", false).trim() || "github-actions[bot]";
  const gitUserEmail =
    input("git-user-email", false).trim() ||
    "github-actions[bot]@users.noreply.github.com";
  const failOnMissing =
    input("fail-on-missing", false).trim().toLowerCase() !== "false";

  if (!repo) fail("No repository provided and GITHUB_REPOSITORY is unset.");

  mask(token);

  const marker = `# ${markerPrefix}:${markerName}`;
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const host = new URL(serverUrl).host;

  const encodedToken = encodeURIComponent(token);
  const cloneUrl = `https://x-access-token:${encodedToken}@${host}/${repo}.git`;

  const workRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "compose-image-marker-update-"),
  );
  const repoDir = path.join(workRoot, "repo");

  console.log(`Cloning ${repo}@${branch}`);
  run("git", ["clone", "--depth", "1", "--branch", branch, cloneUrl, repoDir]);

  run("git", ["config", "user.name", gitUserName], { cwd: repoDir });
  run("git", ["config", "user.email", gitUserEmail], { cwd: repoDir });

  const { markerFound, changedFiles } = updateFiles({
    repoDir,
    filesInput,
    marker,
    image,
  });

  if (!markerFound) {
    setOutput("changed", "false");
    setOutput("files", "");

    const message = `No image line found with marker ${JSON.stringify(marker)}`;

    if (failOnMissing) {
      fail(message);
    }

    console.log(`::warning::${message}`);
    return;
  }

  if (changedFiles.length === 0) {
    console.log("Marker found, but image is already up to date.");
    setOutput("changed", "false");
    setOutput("files", "");
    return;
  }

  console.log("Updated files:");
  for (const file of changedFiles) {
    console.log(`- ${file}`);
  }

  run("git", ["add", "."], { cwd: repoDir });

  const diffResult = run("git", ["diff", "--cached", "--quiet"], {
    cwd: repoDir,
    allowFailure: true,
    capture: true,
  });

  if (diffResult.status === 0) {
    console.log("No staged changes.");
    setOutput("changed", "false");
    setOutput("files", "");
    return;
  }

  const commitMessage =
    commitMessageInput || `chore: update ${markerName} image to ${image}`;

  run("git", ["commit", "-m", commitMessage], { cwd: repoDir });
  run("git", ["push", "origin", `HEAD:${branch}`], { cwd: repoDir });

  setOutput("changed", "true");
  setOutput("files", changedFiles.join(","));
}

main();
