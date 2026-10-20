/** Separate receiver administrator used to prove publication/revocation lock ordering. */
import { writeFileSync } from "node:fs";
import { Repository } from "../../engine/repo.ts";
import { updateTrustedKeys } from "../../engine/signature-policy.ts";
const repository = Repository.open(process.argv[2]!);
const keyId = process.argv[3]!;
const receipt = process.argv[4]!;
process.on("message", () => {
  try {
    updateTrustedKeys(repository.objects, repository.controlDirectory, { keyId, effectiveAt: 0 });
    writeFileSync(receipt, JSON.stringify({ status: "revoked" }));
    process.send!({ status: "revoked" });
  } catch (error) {
    const result = { status: "refused", code: (error as { code: string }).code };
    writeFileSync(receipt, JSON.stringify(result)); process.send!(result);
  }
});
process.send!({ status: "ready" });
