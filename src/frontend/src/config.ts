export let config = {
 aws: {
   region: import.meta.env.VITE_AWS_REGION,
   accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
   secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
   sessionToken: import.meta.env.VITE_AWS_SESSION_TOKEN,
 },
};

export default config;
