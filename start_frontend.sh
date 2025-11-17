docker run -it --rm \
-v $(pwd):/workspace \
--net host \
--name web_server \
-w /workspace/frontend \
seisblue/eew \
/usr/bin/pnpm run dev --host
