container run --rm \
  --name eap-calculators-web \
  --cpus 2 --memory 2G \
  --publish 127.0.0.1:8080:8080 \
  --entrypoint node \
  eap-calculators:4.0.2 /app/server.mjs
