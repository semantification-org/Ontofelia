/**
 * GuardianPolicy — heuristic, human-in-the-loop escalation for dangerous inputs.
 *
 * IMPORTANT: This is defense-in-depth, NOT the security boundary. The hard
 * boundary is the default-deny ToolPolicyEngine (packages/security): `exec`
 * and other dangerous tools must be explicitly allowed, and the sandbox
 * confines execution. Guardian sits on top of that and escalates suspicious
 * `exec`/`cron_manage` payloads to owner approval.
 *
 * A regex blocklist can never fully sandbox a shell — command syntax is too
 * flexible (quoting, variable expansion, encoding, aliases, `$IFS`, etc.), so
 * a determined/adversarial model can bypass any pattern here. The goal is
 * pragmatic coverage of *common* destructive/exfiltration shapes with a low
 * false-positive rate, because a match only gates an approval prompt rather
 * than a hard block. Everyday dev commands (git, pnpm, ls, grep, running a
 * script normally) must NOT trip these patterns.
 */
interface DangerousPattern {
  /** Short human-readable label describing WHAT was detected. */
  label: string;
  pattern: RegExp;
}

export class GuardianPolicy {
  private static DANGEROUS_PATTERNS: DangerousPattern[] = [
    // --- Privilege escalation -------------------------------------------------
    { label: 'privilege escalation (sudo)', pattern: /\bsudo\b/i },
    { label: 'privilege escalation (su/doas)', pattern: /\b(?:su|doas|pkexec)\b/i },

    // --- Recursive / destructive file deletion --------------------------------
    // `rm` carrying BOTH a recursive and a force flag, in any arrangement:
    // -rf, -fr, -r -f, -f -r, --recursive --force, etc. (two lookaheads).
    {
      label: 'recursive force delete',
      pattern: /\brm\s+(?=(?:--?\S+\s+)*(?:-\S*r|--recursive))(?=(?:--?\S+\s+)*(?:-\S*f|--force))/i,
    },
    // `rm` targeting a filesystem-sensitive root: /, ~, $HOME, .., or a bare *.
    {
      label: 'delete of sensitive path',
      pattern: /\brm\b[^|;&\n]*\s(?:\/|~|\$HOME\b|\.\.(?:\/|\s|$)|\*(?:\s|$))/i,
    },
    { label: 'secure erase (shred/wipe)', pattern: /\b(?:shred|wipe|srm)\b/i },
    { label: 'file truncation (truncate/:>)', pattern: /\btruncate\s+-s\s*0\b|(?:^|[;&|])\s*>\s*\/\w/i },

    // --- Disk / device destruction --------------------------------------------
    { label: 'filesystem format (mkfs)', pattern: /\bmkfs\b/i },
    { label: 'raw disk write (dd)', pattern: /\bdd\b[^|;&\n]*\b(?:if|of)=/i },
    { label: 'write to block device', pattern: /(?:>|\btee\b[^|;&\n]*)\s*\/dev\/(?:sd|nvme|vd|hd|mapper|disk)/i },
    { label: 'partition table edit', pattern: /\b(?:fdisk|parted|sgdisk|wipefs)\b/i },

    // --- System control -------------------------------------------------------
    { label: 'system power control', pattern: /\b(?:shutdown|reboot|poweroff|halt|init\s+0|init\s+6)\b/i },
    { label: 'service disable', pattern: /\bsystemctl\s+(?:stop|disable|mask)\b/i },
    { label: 'kill init/pid 1', pattern: /\bkill\s+-9\s+1\b/ },
    { label: 'fork bomb', pattern: /:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*\}\s*;\s*:/ },

    // --- Network / firewall ---------------------------------------------------
    { label: 'firewall manipulation', pattern: /\b(?:iptables|nftables|ufw|firewall-cmd)\b/i },

    // --- Remote code fetched and piped to a shell -----------------------------
    { label: 'pipe download to shell', pattern: /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da|)sh\b/i },
    { label: 'decode-and-execute', pattern: /\bbase64\s+(?:-d|--decode)\b[^|]*\|\s*(?:ba|z|k|da|)sh\b/i },

    // --- Inline code / shell interpreters with embedded payloads --------------
    { label: 'inline interpreter payload', pattern: /\b(?:python[23]?|perl|ruby|php)\b[^|;&\n]*\s-(?:c|e|r)\b/i },
    { label: 'inline node payload', pattern: /\bnode\b[^|;&\n]*\s-(?:e|-eval|p)\b/i },
    { label: 'shell -c payload', pattern: /\b(?:ba|z|k|da|)sh\s+-c\b/i },
    { label: 'shell eval/exec builtin', pattern: /(?:^|[;&|(]|\s)(?:eval|exec)\s+["'`$]/i },
    { label: 'heredoc piped to shell', pattern: /<<-?\s*['"]?\w+['"]?[\s\S]*\|\s*(?:ba|z|k|da|)sh\b/i },

    // --- Permissions / ownership ----------------------------------------------
    { label: 'world-writable chmod', pattern: /\bchmod\s+(?:-R\s+)?0?777\b/i },
    { label: 'recursive ownership change', pattern: /\bchown\s+-R\b/i },

    // --- Package removal ------------------------------------------------------
    { label: 'system package removal', pattern: /\b(?:apt-get|apt|yum|dnf|apk|pacman|brew)\b[^|;&\n]*(?:\b(?:remove|purge|autoremove)\b|\s-R\b)/i },

    // --- Cron / scheduling wipe -----------------------------------------------
    { label: 'crontab wipe', pattern: /\bcrontab\s+-r\b/i },
    { label: 'shell history wipe', pattern: /\bhistory\s+-c\b|\brm\b[^|;&\n]*\.bash_history\b/i },

    // --- User / credential management -----------------------------------------
    { label: 'password change', pattern: /\bpasswd\b/i },
    { label: 'user account management', pattern: /\b(?:useradd|userdel|usermod|adduser|deluser|groupadd)\b/i },

    // --- Filesystem mounting --------------------------------------------------
    { label: 'mount/unmount', pattern: /\b(?:mount|umount)\b/i },

    // --- Writes to system config ----------------------------------------------
    { label: 'write to /etc', pattern: /(?:>|\btee\b[^|;&\n]*)\s*\/etc\//i },
  ];

  static requiresApproval(toolName: string, input: unknown): { required: boolean; reason?: string } {
    let textToTest = '';
    if (toolName === 'exec') {
      textToTest = (input as { command?: string })?.command || '';
    } else if (toolName === 'cron_manage') {
      const payload = input as { label?: string; wakeMessage?: string };
      textToTest = `${payload?.label || ''} ${payload?.wakeMessage || ''}`;
    } else {
      return { required: false };
    }

    const match = this.DANGEROUS_PATTERNS.find(p => p.pattern.test(textToTest));
    if (match) {
      return {
        required: true,
        reason: `Potentially dangerous command detected (${match.label}): ${textToTest.substring(0, 80)}`,
      };
    }
    return { required: false };
  }
}
