import * as fs from 'fs';
import * as path from 'path';

/**
 * Make the throwaway HOME look like an install that already holds data and has
 * no cognitive flag triples: the embedded store starts with one claim. The
 * gateway then treats it as an existing install and leaves every flag as it
 * was (off), which is the state the tests below were written for. A fresh HOME
 * would be a new install, and a new install has the cognitive layer on.
 */
export function seedExistingInstall(home: string): void {
  const dir = path.join(home, '.ontofelia', 'triplestore', 'oxigraph');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dataset.nq'), '<urn:test:s> <urn:test:p> "kept" <urn:ontofelia:claims> .\n', 'utf-8');
}
