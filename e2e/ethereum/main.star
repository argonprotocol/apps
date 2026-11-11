ethereum = import_module("github.com/ethpandaops/ethereum-package/main.star")

def run(plan, args):
    # Standard permissionless CREATE2 proxy required by the SDK's hook publisher.
    # https://github.com/Arachnid/deterministic-deployment-proxy
    args["network_params"].setdefault("additional_preloaded_contracts", {})["0x4e59b44847b379578588920cA78FbF26c0B4956C"] = {
        "balance": "0ETH",
        "code": "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3",
        "storage": {},
        "nonce": 1,
    }
    if args["network_params"]["preset"] == "minimal":
        for participant in args["participants"]:
            for field in ["cl_extra_env_vars", "vc_extra_env_vars"]:
                environment = participant.setdefault(field, {})
                environment.setdefault("TOKIO_WORKER_THREADS", "2")
                environment.setdefault("RAYON_NUM_THREADS", "2")
    return ethereum.run(plan, args)
