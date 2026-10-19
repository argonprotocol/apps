ethereum = import_module("github.com/ethpandaops/ethereum-package/main.star")

def run(plan, args):
    if args["network_params"]["preset"] == "minimal":
        for participant in args["participants"]:
            for field in ["cl_extra_env_vars", "vc_extra_env_vars"]:
                environment = participant.setdefault(field, {})
                environment.setdefault("TOKIO_WORKER_THREADS", "2")
                environment.setdefault("RAYON_NUM_THREADS", "2")
    return ethereum.run(plan, args)
