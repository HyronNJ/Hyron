"""Export and evaluate the gradient-boosted trees used by the map model."""

import numpy as np
import numba


def tree_export(model):
    return {
        "initial": float(model._baseline_prediction[0, 0]),
        "trees": [
            [
                [
                    float(n["value"]),
                    int(n["feature_idx"]),
                    float(n["num_threshold"]),
                    int(n["left"]),
                    int(n["right"]),
                    int(n["is_leaf"]),
                    int(n["missing_go_to_left"]),
                ]
                for n in tree[0].nodes
            ]
            for tree in model._predictors
        ],
    }


def load_trees(head):
    trees = head["trees"]
    sizes = np.array([len(t) for t in trees])
    offsets = np.concatenate([[0], np.cumsum(sizes)[:-1]])
    nodes = np.array([n for t in trees for n in t], dtype=np.float64)
    return float(head["initial"]), nodes, offsets.astype(np.int64)


@numba.njit(cache=True)
def predict(initial, nodes, offsets, X):
    out = np.empty(X.shape[0])
    for r in range(X.shape[0]):
        v = initial
        for t in range(offsets.size):
            base = offsets[t]
            i = 0
            while nodes[base + i, 5] == 0:
                f = int(nodes[base + i, 1])
                x = X[r, f]
                if np.isnan(x):
                    i = int(nodes[base + i, 3] if nodes[base + i, 6] else nodes[base + i, 4])
                else:
                    i = int(nodes[base + i, 3] if x <= nodes[base + i, 2] else nodes[base + i, 4])
            v += nodes[base + i, 0]
        out[r] = v
    return out
