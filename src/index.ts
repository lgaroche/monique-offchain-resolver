import { Server } from "@chainlink/ccip-read-server"
import { ethers } from "ethers"
import { abi as IResolverService_abi } from "@ensdomains/offchain-resolver-contracts/artifacts/contracts/OffchainResolver.sol/IResolverService.json"
import { abi as Resolver_abi } from "@ensdomains/ens-contracts/artifacts/contracts/resolvers/Resolver.sol/Resolver.json"
import { BytesLike, Result } from "ethers/lib/utils"

const Resolver = new ethers.utils.Interface(Resolver_abi)
const signer = new ethers.utils.SigningKey(process.env.SIGNING_KEY ?? "")
const address = ethers.utils.computeAddress(signer.privateKey)
console.log("Signer address:", address)

function decodeDnsName(dnsname: Buffer) {
  const labels = []
  let idx = 0
  while (true) {
    const len = dnsname.readUInt8(idx)
    if (len === 0) break
    labels.push(dnsname.subarray(idx + 1, idx + len + 1).toString("utf8"))
    idx += len + 1
  }
  return labels.join(".")
}

const resolveMonic = async (name: string) => {
  // Monique resolution
  let nodes = name.split(".")
  if (nodes.length < 3) {
    throw new Error("Invalid name")
  }

  let domain = nodes.slice(-2).join(".")
  if (domain !== "monique.id") {
    throw new Error("Invalid domain")
  }

  let words = nodes.slice(0, -2).join("-").split("-")
  console.log("domain", domain)
  console.log("key", words)

  const apiResult = await fetch(
    `https://api.monique.app/resolve/${words.join("%20")}`,
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  )
  if (!apiResult.ok) {
    throw new Error("API error")
  }
  const monic = await apiResult.json()
  console.log("monic", monic)
  return monic
}

const queryHandlers: {
  [key: string]: (name: string, args: Result) => Promise<any[]>
} = {
  "addr(bytes32)": async (name, _args) => {
    const monic = await resolveMonic(name)
    return [monic.address]
  },
  "addr(bytes32,uint256)": async (name, args) => {
    console.log("addr", name, args)
    if (args[0] > 0) {
      return ["0x"]
    }
    const monic = await resolveMonic(name)
    return [monic.address]
  },
  "text(bytes32,string)": async (name, args) => {
    console.log("text", name, args)
    return [""]
  },
  "contenthash(bytes32)": async (name, _args) => {
    console.log("contenthash", name)
    return ["0x"]
  },
}

async function query(
  name: string,
  data: string
): Promise<{ result: BytesLike; validUntil: number }> {
  // Parse the data nested inside the second argument to `resolve`
  const { signature, args } = Resolver.parseTransaction({ data })

  if (ethers.utils.nameprep(name) !== name) {
    throw new Error("Name must be normalised")
  }

  if (ethers.utils.namehash(name) !== args[0]) {
    throw new Error("Name does not match namehash")
  }

  const handler = queryHandlers[signature]
  if (handler === undefined) {
    throw new Error(`Unsupported query function ${signature}`)
  }

  const result = await handler(name, args.slice(1))
  return {
    result: Resolver.encodeFunctionResult(signature, result),
    validUntil: Math.floor(Date.now() / 1000 + 300),
  }
}

const run = async () => {
  const server = new Server()

  server.add(IResolverService_abi, [
    {
      type: "resolve",
      func: async ([encodedName, data]: Result, request) => {
        const name = decodeDnsName(Buffer.from(encodedName.slice(2), "hex"))
        console.log("resolve", name, data)

        const { result, validUntil } = await query(name, data)

        // Hash and sign the response
        let messageHash = ethers.utils.solidityKeccak256(
          ["bytes", "address", "uint64", "bytes32", "bytes32"],
          [
            "0x1900",
            request?.to,
            validUntil,
            ethers.utils.keccak256(request?.data || "0x"),
            ethers.utils.keccak256(result),
          ]
        )
        const sig = signer.signDigest(messageHash)
        const sigData = ethers.utils.joinSignature(sig)
        return [result, validUntil, sigData]
      },
    },
  ])

  const app = server.makeApp("/")
  app.listen(8080, "0.0.0.0", () => {
    console.log("Listening on http://localhost:8080")
  })
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
