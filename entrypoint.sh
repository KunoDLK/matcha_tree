#!/bin/sh
set -e

# Extract the food graph + textures from the datapack/respack on every start,
# so neither food_tree.json nor images/ need to be committed to the repo.
ZIP="${MATCHA_ZIP:-}"
RESPACK="${MATCHA_RESPACK:-}"

if [ -n "$ZIP" ]; then
  respack_args=""
  if [ -n "$RESPACK" ]; then
    respack_args="--respack $RESPACK"
  fi
  echo "extracting from $ZIP ..."
  # shellcheck disable=SC2086
  python3 extract.py --zip "$ZIP" $respack_args \
    -o viewer/food_tree.json --images viewer/images
else
  echo "MATCHA_ZIP not set; using committed food_tree.json if present"
fi

exec python3 app.py --server-port 8080
