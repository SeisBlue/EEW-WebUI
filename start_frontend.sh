docker container rm -f frontend
docker run -it --rm \
-v $(pwd):/workspace \
--net host \
--name frontend \
-w /workspace/frontend \
seisblue/eew \
/usr/bin/pnpm run dev --host
