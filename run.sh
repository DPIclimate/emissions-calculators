mkdir -p inputs/cotton inputs/grains outputs done

container run --rm \
  --name eap-calculators \
  --cpus 2 \
  --memory 2G \
  --volume "$PWD/inputs:/inputs" \
  --volume "$PWD/outputs:/outputs" \
  --volume "$PWD/done:/done" \
  eap-calculators:4.0.2 \
  --watch --workers 2 --timezone Australia/Sydney
