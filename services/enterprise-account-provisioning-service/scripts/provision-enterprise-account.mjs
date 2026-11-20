#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createCloudKmsSecp256k1Signer } from "@red-cup-engineering/sign-ethereum-digest-with-cloud-kms-engineering-services-section";

import { createEnterpriseAccountBinding } from "../src/account-binding.mjs";
import { provisionEnterpriseAccount } from "../src/provision-enterprise-account.mjs";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WORKSPACE = resolve(HERE, "../../../../../../../../../../../../../..");
const SETTLEMENT_CAIP2 = process.env.SETTLEMENT_CAIP2 ?? "eip155:5615611";
if (SETTLEMENT_CAIP2 !== "eip155:5615611") throw new Error(`enterprise-account provisioning is cut over to ${SETTLEMENT_CAIP2}`);
const DEFAULT_DEPLOYMENT = resolve(HERE, "../../../../data/deployments/eip155-5615611-semiotic-exchange.json");

function option(name) { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; }
function required(name) { const value = option(name) ?? process.env[name.replace(/^--/u, "").replaceAll("-", "_").toUpperCase()]; if (!value) throw new Error(`${name} is required`); return value; }

async function metadataAccessToken() {
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "metadata-flavor": "Google" },
  });
  const body = await response.json();
  if (!response.ok || typeof body.access_token !== "string") throw new Error("Google workload identity access token is unavailable");
  return body.access_token;
}

const rpcUrl = required("--rpc-url");
const urn = required("--urn");
const policySigner = required("--policy-signer");
const policyKeyVersion = required("--policy-key-version");
const deployerAddress = required("--deployer-address");
const deployerKeyVersion = required("--deployer-kms-key-version");
const minimumFundingWei = BigInt(option("--minimum-account-funding-wei") ?? process.env.MINIMUM_ACCOUNT_FUNDING_WEI ?? "0");
const workspace = resolve(option("--workspace") ?? process.env.WORKSPACE ?? DEFAULT_WORKSPACE);
const recordOnly = process.argv.includes("--receipt-only") || process.env.RECEIPT_ONLY === "true";
const suppliedSettlement = recordOnly ? undefined : required("--settlement");
const settlement = suppliedSettlement === undefined ? null : resolve(isAbsolute(suppliedSettlement) ? suppliedSettlement : join(workspace, suppliedSettlement));
if (settlement !== null && settlement !== workspace && !settlement.startsWith(`${workspace}${sep}`)) throw new Error("settlement must be inside the supplied workspace");
const manifestPath = settlement === null ? null : join(settlement, "package.json");
if (manifestPath !== null && !existsSync(manifestPath)) throw new Error("settlement package.json is absent");
const manifest = manifestPath === null ? null : JSON.parse(readFileSync(manifestPath, "utf8"));
const nodeId = recordOnly ? required("--node-id") : manifest["x-agentic-metro-enterprise"]?.["node-id"];
if (!nodeId) throw new Error("settlement does not declare x-agentic-metro-enterprise.node-id");
const bindingPath = settlement === null ? null : join(settlement, "content", "evm", "accounts", "eip155-5615611.json");

const deployment = JSON.parse(readFileSync(option("--deployment") ?? process.env.DEPLOYMENT_PATH ?? DEFAULT_DEPLOYMENT, "utf8"));
const deployerSigner = createCloudKmsSecp256k1Signer({
  keyVersion: deployerKeyVersion,
  address: deployerAddress,
  accessToken: metadataAccessToken,
});
const record = await provisionEnterpriseAccount({
  rpcUrl,
  deployment,
  urn,
  policySigner,
  deployerSigner,
  minimumFundingWei,
});
const binding = createEnterpriseAccountBinding({
  nodeId,
  urn,
  chainId: record.chainId,
  account: record.account,
  factory: record.factory,
  policySigner: record.policySigner,
  policyCustody: "remote-cloud-kms-hsm",
  policyKeyVersion,
  userSalt: record.userSalt,
  transaction: record.deployment.transaction,
  block: record.deployment.block,
  accounting: {
    authority: { enterpriseUrn: record.authority.enterpriseUrn, nodeId },
    funding: {
      source: record.funding.source,
      treasury: record.funding.treasury,
      custody: record.funding.custody,
      keyVersion: deployerKeyVersion,
      minimumWei: record.funding.minimumWei,
      balanceWei: record.funding.balanceWei,
      transactions: [...record.funding.transactions],
    },
    chain: {
      deployment: { ...record.chainAccounting.deployment },
      idempotentReconciliation: record.chainAccounting.idempotentReconciliation,
    },
  },
});
if (bindingPath !== null) mkdirSync(dirname(bindingPath), { recursive: true });
if (bindingPath !== null && existsSync(bindingPath)) {
  const existing = JSON.parse(readFileSync(bindingPath, "utf8"));
  if (JSON.stringify(existing) !== JSON.stringify(binding)) throw new Error(`a different ${SETTLEMENT_CAIP2} binding already occupies ${bindingPath}`);
} else if (bindingPath !== null) {
  writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
}
process.stdout.write(`${JSON.stringify({
  type: "EnterpriseAccountProvisioned",
  protocol: "Cloud-KMS/CREATE2/ERC-4337",
  settlement,
  actor: urn,
  account: record.account,
  binding,
  receipt: record,
  localPrivateKeyMaterial: false,
  materialized: bindingPath !== null,
  durableCarrier: recordOnly ? "caller-supplied-existing-receipt-consumer" : "settlement-worktree-binding",
}, null, 2)}\n`);
