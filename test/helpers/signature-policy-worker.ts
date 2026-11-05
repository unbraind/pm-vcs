/** One real receiver administration attempt; process completion fences the parent's lease release. */
import { Repository } from "../../engine/repo.ts";
import { updateTrustedKeys } from "../../engine/signature-policy.ts";
const repository = Repository.open(process.argv[2]!);
const keyId = process.argv[3]!;
try {
  updateTrustedKeys(repository.objects, repository.controlDirectory, { keyId, effectiveAt: 0 });
  process.stdout.write(JSON.stringify({ status: "revoked" }));
} catch (error) {
  process.stdout.write(JSON.stringify({ status: "refused", code: (error as { code: string }).code }));
}
