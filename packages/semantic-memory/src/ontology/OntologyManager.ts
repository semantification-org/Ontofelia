import * as fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

export interface OntologyVersion {
  version: string;          // Semver or timestamp
  filePath: string;
  createdAt: string;
  description?: string;
  active: boolean;
}

export interface OntologyProposal {
  id: string;
  agentId: string;
  turtlePatch: string;     // Neuer Turtle-Inhalt
  description: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
}

export class OntologyManager {
  private versionsDir: string;
  private proposalsDir: string;
  private activeFile: string;
  private coreFile: string;

  constructor(
    private agentId: string,
    private basePath: string   // ~/.ontofelia/ontology/agents/{agentId}/
  ) {
    this.versionsDir = path.join(this.basePath, 'versions');
    this.proposalsDir = path.join(this.basePath, 'proposals');
    this.activeFile = path.join(this.basePath, 'active.json');
    this.coreFile = path.join(this.basePath, 'core.ttl');
  }

  /** Initialize: create directories, copy core ontology as v0. */
  async initialize(coreOntologyPath: string): Promise<void> {
    mkdirSync(this.versionsDir, { recursive: true });
    mkdirSync(this.proposalsDir, { recursive: true });

    if (!existsSync(this.coreFile) && existsSync(coreOntologyPath)) {
      await fs.copyFile(coreOntologyPath, this.coreFile);
    }

    if (!existsSync(this.activeFile)) {
      const v0Path = path.join(this.versionsDir, 'v000.ttl');
      if (existsSync(coreOntologyPath)) {
        await fs.copyFile(coreOntologyPath, v0Path);
      } else {
        await fs.writeFile(v0Path, '# Empty Ontology v000\n');
      }
      
      await fs.writeFile(this.activeFile, JSON.stringify({
        version: 'v000',
        filePath: v0Path,
        createdAt: new Date().toISOString(),
        description: 'Initial Core Ontology',
        active: true
      }, null, 2));
    }
  }

  /** Liste alle Versionen */
  async listVersions(): Promise<OntologyVersion[]> {
    const files = await fs.readdir(this.versionsDir);
    const active = await this.getActiveVersion();
    
    const versions: OntologyVersion[] = [];
    for (const file of files) {
      if (file.endsWith('.ttl')) {
        const stat = await fs.stat(path.join(this.versionsDir, file));
        const ver = file.replace('.ttl', '');
        versions.push({
          version: ver,
          filePath: path.join(this.versionsDir, file),
          createdAt: stat.birthtime.toISOString(),
          active: active.version === ver
        });
      }
    }
    return versions.sort((a, b) => b.version.localeCompare(a.version));
  }

  /** Hole aktive Version */
  async getActiveVersion(): Promise<OntologyVersion> {
    if (!existsSync(this.activeFile)) {
      throw new Error('OntologyManager not initialized');
    }
    const content = await fs.readFile(this.activeFile, 'utf-8');
    return JSON.parse(content);
  }

  /** Erstelle neue Version aus Turtle-Inhalt */
  async createVersion(turtleContent: string, description?: string): Promise<OntologyVersion> {
    const versions = await this.listVersions();
    const nextVerNum = versions.length > 0 ? parseInt(versions[0].version.replace('v', '')) + 1 : 1;
    const nextVerStr = `v${nextVerNum.toString().padStart(3, '0')}`;
    const nextFilePath = path.join(this.versionsDir, `${nextVerStr}.ttl`);

    await fs.writeFile(nextFilePath, turtleContent, 'utf-8');

    const newVersion: OntologyVersion = {
      version: nextVerStr,
      filePath: nextFilePath,
      createdAt: new Date().toISOString(),
      description,
      active: true
    };

    await fs.writeFile(this.activeFile, JSON.stringify(newVersion, null, 2));
    return newVersion;
  }

  /** Roll back to an earlier version. */
  async rollback(version: string): Promise<OntologyVersion> {
    const targetFile = path.join(this.versionsDir, `${version}.ttl`);
    if (!existsSync(targetFile)) {
      throw new Error(`Version ${version} not found`);
    }

    const stat = await fs.stat(targetFile);
    const activeVersion: OntologyVersion = {
      version: version,
      filePath: targetFile,
      createdAt: stat.birthtime.toISOString(),
      description: `Rolled back to ${version}`,
      active: true
    };

    await fs.writeFile(this.activeFile, JSON.stringify(activeVersion, null, 2));
    return activeVersion;
  }

  /** Hole Turtle-Inhalt einer Version */
  async getVersionContent(version: string): Promise<string> {
    const targetFile = path.join(this.versionsDir, `${version}.ttl`);
    if (!existsSync(targetFile)) {
      throw new Error(`Version ${version} not found`);
    }
    return await fs.readFile(targetFile, 'utf-8');
  }

  /** Speichere einen Ontologie-Vorschlag */
  async saveProposal(proposal: OntologyProposal): Promise<void> {
    const filePath = path.join(this.proposalsDir, `p-${proposal.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(proposal, null, 2));
  }

  /** List open proposals. */
  async listProposals(): Promise<OntologyProposal[]> {
    const files = await fs.readdir(this.proposalsDir);
    const proposals: OntologyProposal[] = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(this.proposalsDir, file), 'utf-8');
        proposals.push(JSON.parse(content));
      }
    }
    return proposals;
  }

  /** Genehmige einen Vorschlag → neue Version */
  async approveProposal(proposalId: string): Promise<OntologyVersion> {
    const filePath = path.join(this.proposalsDir, `p-${proposalId}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const proposal: OntologyProposal = JSON.parse(content);
    
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal ${proposalId} is already ${proposal.status}`);
    }

    const newVersion = await this.createVersion(proposal.turtlePatch, proposal.description);
    
    proposal.status = 'approved';
    await fs.writeFile(filePath, JSON.stringify(proposal, null, 2));

    return newVersion;
  }
}
