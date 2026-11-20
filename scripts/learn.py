import json
import sys

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import SGDRegressor

data = json.load(sys.stdin)
if "feedback" in data:
    matrix = TfidfVectorizer(ngram_range=(1, 2), stop_words="english").fit_transform(
        [data["question"], *data["feedback"]]
    )
    scores = (matrix[1:] @ matrix[0].T).toarray().ravel()
    print(json.dumps(int(scores.argmax()) if scores.max() > 0 else -1))
else:
    model = SGDRegressor(alpha=data["alpha"], random_state=data["seed"], learning_rate="constant", eta0=0.003)
    features = np.array(data["x"])
    targets = np.array(data["y"])
    loss = []
    for _ in range(30):
        model.partial_fit(features, targets)
        loss.append(float(np.mean((model.predict(features) - targets) ** 2)))
    print(json.dumps(dict(coefficients=model.coef_.tolist(), intercept=float(model.intercept_[0]), loss=loss), allow_nan=False))
