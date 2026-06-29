export class GuardianPolicy {
  private static DANGEROUS_PATTERNS = [
    /\bsudo\b/i,
    /\brm\s+(-[rf]+\s+)?\//, 
    /\bshutdown\b/i, /\breboot\b/i,
    /\bmkfs\b/i, /\bdd\s+if=/i,
    /\bchmod\s+777\b/,
    /curl.*\|\s*(bash|sh)\b/i,
    /apt-get\s+(remove|purge)\b/i,
    /\bkill\s+-9\s+1\b/,
    />\s*\/dev\/sd/i,
    /\bsystemctl\s+(stop|disable|mask)/i,
    /\biptables\b/i,
    /\bufw\b/i,
    /wget.*\|\s*(bash|sh)\b/i,
    /python[23]?\s+-c/i,
    /\bnode\s+-e/i,
    /\bcrontab\s+-r\b/i,
    /\bpasswd\b/i,
    /\buseradd\b/i, /\buserdel\b/i,
    /\bmount\b/i, /\bumount\b/i,
    /\bchown\s+-R\b/i,
    />\s*\/etc\//i,
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

    const match = this.DANGEROUS_PATTERNS.find(p => p.test(textToTest));
    if (match) {
      return { required: true, reason: `Potentially dangerous command detected: ${textToTest.substring(0, 50)}` };
    }
    return { required: false };
  }
}
