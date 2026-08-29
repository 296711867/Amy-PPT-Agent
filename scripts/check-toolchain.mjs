const requiredNodeMajor = 20
const requiredPnpmMajor = 10
const nodeMajor = Number(process.versions.node.split('.')[0])
const userAgent = process.env.npm_config_user_agent || ''
const pnpmMatch = /pnpm\/(\d+)(?:\.\d+){0,2}/i.exec(userAgent)
const pnpmMajor = pnpmMatch ? Number(pnpmMatch[1]) : null

const failures = []
if (!Number.isFinite(nodeMajor) || nodeMajor < requiredNodeMajor) {
  failures.push(`Node.js ${requiredNodeMajor}+ is required; found ${process.versions.node}.`)
}
if (pnpmMajor !== null && pnpmMajor !== requiredPnpmMajor) {
  failures.push(`pnpm ${requiredPnpmMajor}.x is required; found pnpm ${pnpmMajor}.x.`)
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`[toolchain] ${failure}\n`)
  process.stderr.write(
    '[toolchain] Fix: corepack enable && corepack prepare pnpm@10.10.0 --activate\n'
  )
  process.exitCode = 1
} else {
  const pnpmLabel = pnpmMajor === null ? 'not detected (run through pnpm for a full check)' : '10.x'
  process.stdout.write(`[toolchain] Node.js ${process.versions.node}; pnpm ${pnpmLabel}; OK\n`)
}
