from __future__ import annotations

import math
from collections import Counter
from typing import Any

import numpy as np
from imblearn.over_sampling import SMOTE
from pyproj import CRS, Transformer
from shapely.geometry import shape
from shapely.ops import transform
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import train_test_split

RF_HYPERPARAMETERS = {
    "n_estimators": 500,
    "max_depth": 20,
    "min_samples_split": 10,
    "min_samples_leaf": 4,
    "random_state": 42,
}

PREDICTION_BATCH_SIZE = 1024
APPROX_HEIGHT_PER_LEVEL_METERS = 3.2
MAX_OVERSAMPLING_MULTIPLIER = 10
MAJORITY_TARGET_BOOST = 1
LEVEL_FALLBACK_PROPERTIES = [
    "building_levels",
    "building:levels",
    "levels",
]

MODEL_FEATURE_NAMES = [
    "perimeter",
    "aspect_ratio",
    "compactness_ratio",
    "convexity_ratio",
    "building_footprint",
    "rectangularity",
    "vertex_count",
    "hole_count",
    "perimeter_area_ratio",
    "height",
]


def _emit_progress(progress_callback, stage: str, progress: int, message: str) -> None:
    if progress_callback:
        progress_callback(stage=stage, progress=progress, message=message)


def _looks_like_geographic_coordinates(bounds: tuple[float, float, float, float]) -> bool:
    min_x, min_y, max_x, max_y = bounds
    return -180.0 <= min_x <= 180.0 and -180.0 <= max_x <= 180.0 and -90.0 <= min_y <= 90.0 and -90.0 <= max_y <= 90.0


def _estimate_metric_crs(geom) -> CRS | None:
    if geom.is_empty:
        return None

    if not _looks_like_geographic_coordinates(geom.bounds):
        return None

    centroid = geom.centroid
    zone = int((centroid.x + 180) / 6) + 1
    epsg = 32600 + zone if centroid.y >= 0 else 32700 + zone
    return CRS.from_epsg(epsg)


def _project_to_metric(geom):
    target_crs = _estimate_metric_crs(geom)
    if target_crs is None:
        return geom

    transformer = Transformer.from_crs(CRS.from_epsg(4326), target_crs, always_xy=True)
    return transform(transformer.transform, geom)


def _iter_polygon_parts(geom) -> list[Any]:
    if geom.is_empty:
        return []

    geom_type = getattr(geom, "geom_type", "")
    if geom_type == "Polygon":
        return [geom]
    if geom_type == "MultiPolygon":
        return list(geom.geoms)
    if hasattr(geom, "geoms"):
        polygon_parts = []
        for part in geom.geoms:
            polygon_parts.extend(_iter_polygon_parts(part))
        return polygon_parts

    return []


def _minimum_rotated_rectangle_metrics(geom) -> tuple[float, float, float]:
    rectangle = geom.minimum_rotated_rectangle
    if not hasattr(rectangle, "exterior"):
        return 0.0, 0.0, 0.0

    coordinates = list(rectangle.exterior.coords)
    lengths = []

    for index in range(len(coordinates) - 1):
        x1, y1 = coordinates[index]
        x2, y2 = coordinates[index + 1]
        lengths.append(math.dist((x1, y1), (x2, y2)))

    non_zero_lengths = [length for length in lengths if length > 0]
    if not non_zero_lengths:
        return 0.0, 0.0, float(getattr(rectangle, "area", 0.0))

    return max(non_zero_lengths), min(non_zero_lengths), float(rectangle.area)


def _vertex_count(geom) -> int:
    count = 0
    for polygon in _iter_polygon_parts(geom):
        count += max(len(list(polygon.exterior.coords)) - 1, 0)
        for interior in polygon.interiors:
            count += max(len(list(interior.coords)) - 1, 0)
    return count


def _hole_count(geom) -> int:
    return sum(len(polygon.interiors) for polygon in _iter_polygon_parts(geom))


def geometry_features(geometry: dict[str, Any] | None) -> dict[str, float]:
    if not geometry:
        return {name: 0.0 for name in MODEL_FEATURE_NAMES if name != "height"}

    try:
        geom = shape(geometry)
    except Exception:
        return {name: 0.0 for name in MODEL_FEATURE_NAMES if name != "height"}

    if geom.is_empty:
        return {name: 0.0 for name in MODEL_FEATURE_NAMES if name != "height"}

    metric_geom = _project_to_metric(geom)
    building_footprint = float(metric_geom.area)
    perimeter = float(metric_geom.length)
    longer_side, shorter_side, rectangle_area = _minimum_rotated_rectangle_metrics(metric_geom)
    aspect_ratio = (longer_side / shorter_side) if shorter_side > 0 else 0.0
    compactness_ratio = (4.0 * math.pi * building_footprint / (perimeter ** 2)) if building_footprint > 0 and perimeter > 0 else 0.0
    convex_hull_area = float(metric_geom.convex_hull.area)
    convexity_ratio = (building_footprint / convex_hull_area) if convex_hull_area > 0 else 0.0
    rectangularity = (building_footprint / rectangle_area) if rectangle_area > 0 else 0.0
    vertex_count = float(_vertex_count(metric_geom))
    hole_count = float(_hole_count(metric_geom))
    perimeter_area_ratio = (perimeter / building_footprint) if building_footprint > 0 else 0.0

    return {
        "perimeter": perimeter,
        "aspect_ratio": aspect_ratio,
        "compactness_ratio": compactness_ratio,
        "convexity_ratio": convexity_ratio,
        "building_footprint": building_footprint,
        "rectangularity": rectangularity,
        "vertex_count": vertex_count,
        "hole_count": hole_count,
        "perimeter_area_ratio": perimeter_area_ratio,
    }


def numeric_property_value(properties: dict[str, Any], property_name: str) -> float:
    raw_value = properties.get(property_name)

    if raw_value in (None, "", "None", "null"):
        return 0.0

    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return 0.0

    if math.isnan(value) or math.isinf(value):
        return 0.0

    return value


def height_like_feature_value(properties: dict[str, Any], height_property: str) -> float:
    primary_value = numeric_property_value(properties, height_property)
    if primary_value > 0:
        return primary_value

    for fallback_property in LEVEL_FALLBACK_PROPERTIES:
        if fallback_property == height_property:
            continue

        fallback_value = numeric_property_value(properties, fallback_property)
        if fallback_value > 0:
            return fallback_value * APPROX_HEIGHT_PER_LEVEL_METERS

    return 0.0


def build_feature_matrix(
    features: list[dict[str, Any]],
    archetype_property: str,
    height_property: str,
    unknown_values: set[str],
) -> tuple[np.ndarray, list[dict[str, Any]], list[dict[str, Any]], np.ndarray]:
    rows: list[list[float]] = []
    labeled_rows: list[dict[str, Any]] = []
    unknown_rows: list[dict[str, Any]] = []
    labels: list[str] = []

    for index, feature in enumerate(features):
        properties = feature.get("properties") or {}
        geometry = feature.get("geometry")
        archetype = properties.get(archetype_property)
        label = "" if archetype is None else str(archetype).strip()
        feature_vector = geometry_features(geometry)
        feature_vector["height"] = height_like_feature_value(properties, height_property)
        rows.append([feature_vector[name] for name in MODEL_FEATURE_NAMES])

        row_meta = {
            "feature_index": index,
            "label": label,
            "feature_vector": feature_vector,
        }

        if label in unknown_values:
            unknown_rows.append(row_meta)
        else:
            labeled_rows.append(row_meta)
            labels.append(label)

    return np.asarray(rows, dtype=float), labeled_rows, unknown_rows, np.asarray(labels)


def build_dynamic_smote_strategy(class_counts: Counter[str]) -> tuple[dict[str, int], list[str], int | None]:
    majority_count = max(class_counts.values())
    sampling_strategy: dict[str, int] = {}
    skipped_classes: list[str] = []
    eligible_min_count: int | None = None

    for label, count in class_counts.items():
        if count >= majority_count:
            continue

        boosted_majority_target = int(round(majority_count * MAJORITY_TARGET_BOOST))
        multiplier_limited_target = int(round(count * MAX_OVERSAMPLING_MULTIPLIER))
        target_ceiling = max(count, min(boosted_majority_target, multiplier_limited_target))
        target_multiplier = min(MAX_OVERSAMPLING_MULTIPLIER, target_ceiling / count)
        target_count = int(round(count * target_multiplier))
        target_count = max(count, min(target_ceiling, target_count))

        if target_count <= count:
            continue

        if count < 2:
            skipped_classes.append(label)
            continue

        sampling_strategy[label] = target_count
        eligible_min_count = count if eligible_min_count is None else min(eligible_min_count, count)

    k_neighbors = None
    if eligible_min_count is not None:
        k_neighbors = min(5, eligible_min_count - 1)

    return sampling_strategy, skipped_classes, k_neighbors


def train_random_forest(
    X_train: np.ndarray,
    y_train: np.ndarray,
    random_state: int,
) -> tuple[RandomForestClassifier, dict[str, Any]]:
    class_counts = Counter(y_train.tolist())
    sampling_strategy, skipped_classes, k_neighbors = build_dynamic_smote_strategy(class_counts)
    X_resampled = X_train
    y_resampled = y_train

    if sampling_strategy and k_neighbors and k_neighbors >= 1:
        smote = SMOTE(
            sampling_strategy=sampling_strategy,
            k_neighbors=k_neighbors,
            random_state=random_state,
        )
        X_resampled, y_resampled = smote.fit_resample(X_train, y_train)

    classifier = RandomForestClassifier(
        n_estimators=RF_HYPERPARAMETERS["n_estimators"],
        max_depth=RF_HYPERPARAMETERS["max_depth"],
        min_samples_split=RF_HYPERPARAMETERS["min_samples_split"],
        min_samples_leaf=RF_HYPERPARAMETERS["min_samples_leaf"],
        random_state=random_state,
        class_weight=None,
        n_jobs=-1,
    )
    classifier.fit(X_resampled, y_resampled)

    return classifier, {
        "applied": bool(sampling_strategy),
        "sampling_strategy": sampling_strategy,
        "skipped_classes": skipped_classes,
        "k_neighbors": k_neighbors,
        "original_class_distribution": dict(class_counts),
        "resampled_class_distribution": dict(Counter(y_resampled.tolist())),
    }


def predict_archetypes(
    geojson: dict[str, Any],
    archetype_property: str = "building_archetype",
    height_property: str = "height",
    confidence_threshold: float = 0.2,
    unknown_values: set[str] | None = None,
    test_size: float = 0.2,
    random_state: int = 42,
    n_estimators: int = 500,
    progress_callback=None,
) -> dict[str, Any]:
    _ = n_estimators
    _emit_progress(progress_callback, "validating", 36, "Validating GeoJSON input")

    if geojson.get("type") != "FeatureCollection":
        raise ValueError("Input must be a GeoJSON FeatureCollection")

    features = geojson.get("features") or []
    if not features:
        raise ValueError("GeoJSON contains no features")

    unknown_values = unknown_values or {"unknown", "Unknown", "UNKNOWN", "", "null", "None"}
    _emit_progress(progress_callback, "feature_engineering", 48, "Computing geometry and height features")
    feature_matrix, labeled_rows, unknown_rows, labels = build_feature_matrix(features, archetype_property, height_property, unknown_values)

    if len(labeled_rows) < 10:
        raise ValueError("At least 10 labeled features are required for training")

    class_counts = Counter(labels.tolist())
    if len(class_counts) < 2:
        raise ValueError("At least two known archetype classes are required for training")

    labeled_indices = [row["feature_index"] for row in labeled_rows]
    unknown_indices = [row["feature_index"] for row in unknown_rows]
    X_labeled = feature_matrix[labeled_indices]
    y_labeled = labels

    can_stratify = min(class_counts.values()) >= 2
    stratify = y_labeled if can_stratify else None

    _emit_progress(progress_callback, "split", 58, "Splitting labeled buildings into train and test groups")
    X_train, X_test, y_train, y_test, train_feature_indices, test_feature_indices = train_test_split(
        X_labeled,
        y_labeled,
        labeled_indices,
        test_size=test_size,
        random_state=random_state,
        stratify=stratify,
    )

    _emit_progress(progress_callback, "smote", 68, "Applying dynamic SMOTE resampling to minority classes")
    validation_model, validation_smote_summary = train_random_forest(X_train, y_train, random_state)

    _emit_progress(progress_callback, "train_test", 78, "Training validation random forest")
    y_pred = validation_model.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    report = classification_report(y_test, y_pred, output_dict=True, zero_division=0)
    matrix = confusion_matrix(y_test, y_pred, labels=sorted(class_counts.keys()))

    _emit_progress(progress_callback, "final_train", 88, "Training final random forest with dynamic SMOTE")
    final_model, final_smote_summary = train_random_forest(X_labeled, y_labeled, random_state)

    _emit_progress(progress_callback, "predicting", 94, "Predicting unknown archetypes")
    predictions: list[dict[str, Any]] = []
    applied_prediction_count = 0
    retained_unknown_count = 0
    if unknown_indices:
        unknown_matrix = feature_matrix[unknown_indices]
        total_unknown = len(unknown_indices)
        unknown_row_lookup = {row["feature_index"]: row for row in unknown_rows}

        for batch_start in range(0, total_unknown, PREDICTION_BATCH_SIZE):
            batch_end = min(batch_start + PREDICTION_BATCH_SIZE, total_unknown)
            batch_indices = unknown_indices[batch_start:batch_end]
            batch_matrix = unknown_matrix[batch_start:batch_end]
            batch_predictions = final_model.predict(batch_matrix)
            batch_probabilities = final_model.predict_proba(batch_matrix)

            for feature_index, predicted, probabilities in zip(batch_indices, batch_predictions, batch_probabilities):
                probability_map = {label: float(probability) for label, probability in zip(final_model.classes_, probabilities)}
                confidence = float(max(probabilities)) if len(probabilities) else 0.0
                original_unknown_label = unknown_row_lookup.get(feature_index, {}).get("label") or "unknown"
                assign_prediction = confidence >= confidence_threshold
                final_label = str(predicted) if assign_prediction else original_unknown_label

                predictions.append(
                    {
                        "feature_index": feature_index,
                        "predicted_archetype": final_label,
                        "suggested_archetype": str(predicted),
                        "probability": confidence,
                        "assigned": assign_prediction,
                        "class_probabilities": probability_map,
                    }
                )

                feature = features[feature_index]
                feature.setdefault("properties", {})[archetype_property] = final_label
                feature["properties"]["ml_probability"] = confidence
                feature["properties"]["ml_prediction_source"] = "random_forest_smote" if assign_prediction else "low_confidence_retained_unknown"
                feature["properties"]["ml_suggested_archetype"] = str(predicted)

                if assign_prediction:
                    applied_prediction_count += 1
                else:
                    retained_unknown_count += 1

            completed = batch_end / total_unknown
            progress = 94 + int(completed * 5)
            _emit_progress(
                progress_callback,
                "predicting",
                min(progress, 99),
                f"Predicting unknown archetypes ({batch_end}/{total_unknown})",
            )

    feature_importance = [
        {"feature": name, "importance": float(value)}
        for name, value in sorted(
            zip(MODEL_FEATURE_NAMES, final_model.feature_importances_),
            key=lambda item: item[1],
            reverse=True,
        )
    ]

    _emit_progress(progress_callback, "completed", 100, "Prediction completed")

    return {
        "metrics": {
            "accuracy": float(accuracy),
            "test_size": test_size,
            "random_state": random_state,
            "n_estimators": RF_HYPERPARAMETERS["n_estimators"],
            "max_depth": RF_HYPERPARAMETERS["max_depth"],
            "min_samples_split": RF_HYPERPARAMETERS["min_samples_split"],
            "min_samples_leaf": RF_HYPERPARAMETERS["min_samples_leaf"],
            "labeled_count": len(labeled_rows),
            "unknown_count": len(unknown_rows),
            "predicted_count": applied_prediction_count,
            "retained_unknown_count": retained_unknown_count,
            "confidence_threshold": confidence_threshold,
            "train_count": len(train_feature_indices),
            "test_count": len(test_feature_indices),
            "class_distribution": dict(class_counts),
            "classification_report": report,
            "confusion_matrix": {
                "labels": sorted(class_counts.keys()),
                "matrix": matrix.tolist(),
            },
            "geometry_features": MODEL_FEATURE_NAMES,
            "validation_smote": validation_smote_summary,
            "final_smote": final_smote_summary,
        },
        "predictions": predictions,
        "feature_importance": feature_importance,
        "geojson": geojson,
    }